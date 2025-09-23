import type { IncomingMessage, ServerResponse } from 'http'
import {
  getOriginalCodeFrame,
  ignoreListAnonymousStackFramesIfSandwiched,
  type IgnorableStackFrame,
  type OriginalStackFrameResponse,
  type OriginalStackFramesRequest,
  type OriginalStackFramesResponse,
  type StackFrame,
} from '../../next-devtools/server/shared'
import { middlewareResponse } from '../../next-devtools/server/middleware-response'
import path from 'path'
import { openFileInEditor } from '../../next-devtools/server/launch-editor'
import {
  SourceMapConsumer,
  type NullableMappedPosition,
} from 'next/dist/compiled/source-map08'
import type { Project, TurbopackStackFrame } from '../../build/swc/types'
import {
  type ModernSourceMapPayload,
  devirtualizeReactServerURL,
  findApplicableSourceMapPayload,
} from '../lib/source-maps'
import { findSourceMap, type SourceMap } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'

// --- Windows/URL normalization helpers (server side) ---
// const toPosix = (p: string) => p.replace(/\\/g, '/')
const decodeMaybe = (s: string | undefined) => {
  if (!s) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
function normalizeToProjectRelative(
  mapped: string,
  projectPath: string
): string {
  try {
    // Convert Windows absolute paths (C:\...) to file URLs so fileURLToPath works uniformly
    if (!mapped.startsWith('file://') && path.isAbsolute(mapped)) {
      mapped = pathToFileURL(mapped).href
    }
    if (mapped.startsWith('file://')) {
      const abs = fileURLToPath(mapped)
      return path.relative(projectPath, abs).replace(/\\/g, '/')
    }
  } catch {
    // fall through
  }
  // If it's already project-relative or some non-file scheme, just normalize slashes
  return mapped.replace(/\\/g, '/')
}

const ensureFileUrl = (input: string | undefined): string | undefined => {
  if (!input) return input
  const s = decodeMaybe(input)!
  if (s.startsWith('file://')) return s
  // Windows absolute like C:/...  (POSIX absolute /... handled by URL too)
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('/')) {
    return pathToFileURL(s).href
  }
  // passthrough other schemes (http:, turbopack:, node:, etc.)
  return s
}
async function loadSourceMapPayload(
  project: Project,
  sourceUrlHref: string
): Promise<ModernSourceMapPayload | undefined> {
  // 1) Try Node’s cache (native)
  try {
    const native = findSourceMap(sourceUrlHref)?.payload as
      | ModernSourceMapPayload
      | undefined
    if (native) return native
  } catch {
    // ignore; we'll fall back to Turbopack
  }

  // 2) Ask Turbopack directly
  try {
    const smString = await project.getSourceMap(sourceUrlHref)
    if (smString) {
      return JSON.parse(smString) as ModernSourceMapPayload
    }
  } catch {
    // ignore; final fallback is "undefined"
  }

  return undefined
}
function heuristicSourceFromChunkPath(chunkPath: string): string | null {
  const p = chunkPath.replace(/\\/g, '/')
  if (!p.includes('/src_app_') && !p.includes('/src_pages_')) return null

  const file = p.split('/').pop() || ''
  // matches: src_app_Crash_tsx_<hash>._.js OR src_pages_index_tsx_<hash>._.js
  const m = file.match(/^src_(app|pages)_(.+?)_(tsx|ts|jsx|js)_/i)
  if (!m) return null
  const [, root, underscored, ext] = m
  const pathPart = underscored.replace(/_/g, '/')
  return `src/${root}/${pathPart}.${ext}`
}
function shouldIgnorePath(modulePath: string): boolean {
  return (
    modulePath.includes('node_modules') ||
    // Only relevant for when Next.js is symlinked e.g. in the Next.js monorepo
    modulePath.includes('next/dist') ||
    modulePath.includes('_next_dist_compiled_') ||
    modulePath.startsWith('node:') ||
    // ignore compiled vendor chunks (react-dom, etc) in .next/static/chunks
    /[\\/]\.next[\\/]static[\\/]chunks[\\/]/i.test(modulePath) ||
    /react-dom/i.test(modulePath) ||
    /_compiled_react-dom/i.test(modulePath)
  )
}

const currentSourcesByFile: Map<string, Promise<string | null>> = new Map()
/**
 * @returns 1-based lines and 1-based columns
 */
async function batchedTraceSource(
  project: Project,
  projectPath: string,
  frame: TurbopackStackFrame
): Promise<{ frame: IgnorableStackFrame; source: string | null } | undefined> {
  const file = frame.file
    ? // TODO(veil): Why are the frames sent encoded?
      decodeURIComponent(frame.file)
    : undefined

  if (!file) return

  // For node internals they cannot traced the actual source code with project.traceSource,
  // we need an early return to indicate it's ignored to avoid the unknown scheme error from `project.traceSource`.
  if (file.startsWith('node:')) {
    return {
      frame: {
        file: file,
        line1: frame.line ?? null,
        column1: frame.column ?? null,
        methodName: frame.methodName ?? '<unknown>',
        ignored: true,
        arguments: [],
      },
      source: null,
    }
  }

  const currentDirectoryFileUrl = pathToFileURL(process.cwd()).href

  const sourceFrame = await project.traceSource(frame, currentDirectoryFileUrl)
  if (!sourceFrame) {
    return {
      frame: {
        file: normalizeToProjectRelative(file, projectPath)!,
        line1: frame.line ?? null,
        column1: frame.column ?? null,
        methodName: frame.methodName ?? '<unknown>',
        ignored: shouldIgnorePath(file),
        arguments: [],
      },
      source: null,
    }
  }

  let source = null
  const originalFile = sourceFrame.originalFile ?? null
  // Prefer original file if present; otherwise use the traced file.
  const preferred = sourceFrame.originalFile ?? sourceFrame.file

  const normalizedPreferred = preferred
    ? normalizeToProjectRelative(preferred, projectPath)!
    : null
  // const preferredFile = originalFile ?? sourceFrame.file
  let preferredFile = originalFile ?? sourceFrame.file
  if (!originalFile && sourceFrame.file) {
    const guess = heuristicSourceFromChunkPath(sourceFrame.file)
    if (guess) {
      console.log('[overlay] heuristic mapped', sourceFrame.file, '->', guess)
      preferredFile = guess
    }
  }
  // Don't look up source for node_modules or internals. These can often be large bundled files.
  const ignored =
    shouldIgnorePath(originalFile ?? sourceFrame.file) ||
    !!sourceFrame.isInternal ||
    /[\\/]\.next[\\/]static[\\/]chunks[\\/].*react-dom/i.test(preferredFile) ||
    /[\\/]_compiled_react-dom/i.test(preferredFile)

  if (originalFile && !ignored) {
    let sourcePromise = currentSourcesByFile.get(originalFile)
    if (!sourcePromise) {
      sourcePromise = project.getSourceForAsset(originalFile)
      currentSourcesByFile.set(originalFile, sourcePromise)
      setTimeout(() => {
        // Cache file reads for 100ms, as frames will often reference the same
        // files and can be large.
        currentSourcesByFile.delete(originalFile!)
      }, 100)
    }
    source = await sourcePromise
  }

  // TODO: get ignoredList from turbopack source map
  const ignorableFrame: IgnorableStackFrame = {
    file: normalizedPreferred ?? sourceFrame.file,
    line1: sourceFrame.line ?? null,
    column1: sourceFrame.column ?? null,
    methodName:
      // We ignore the sourcemapped name since it won't be the correct name.
      // The callsite will point to the column of the variable name instead of the
      // name of the enclosing function.
      // TODO(NDX-531): Spy on prepareStackTrace to get the enclosing line number for method name mapping.
      frame.methodName ?? '<unknown>',
    ignored,
    arguments: [],
  }

  return {
    frame: ignorableFrame,
    source,
  }
}

function parseFile(fileParam: string | null): string | undefined {
  if (!fileParam) {
    return undefined
  }

  return devirtualizeReactServerURL(fileParam)
}

function createStackFrames(
  body: OriginalStackFramesRequest
): TurbopackStackFrame[] {
  const { frames, isServer } = body

  return frames
    .map((frame): TurbopackStackFrame | undefined => {
      const file = ensureFileUrl(parseFile(frame.file))
      if (!file) {
        return undefined
      }

      return {
        file,
        methodName: frame.methodName ?? '<unknown>',
        line: frame.line1 ?? undefined,
        column: frame.column1 ?? undefined,
        isServer,
      }
    })
    .filter((f): f is TurbopackStackFrame => f !== undefined)
}

function createStackFrame(
  searchParams: URLSearchParams
): TurbopackStackFrame | undefined {
  const file = ensureFileUrl(parseFile(searchParams.get('file')))

  if (!file) {
    return undefined
  }

  return {
    file,
    methodName: searchParams.get('methodName') ?? '<unknown>',
    line: parseInt(searchParams.get('line1') ?? '0', 10) || undefined,
    column: parseInt(searchParams.get('column1') ?? '0', 10) || undefined,
    isServer: searchParams.get('isServer') === 'true',
  }
}

/**
 * @returns 1-based lines and 1-based columns
 */
async function nativeTraceSource(
  project: Project,
  frame: TurbopackStackFrame,
  projectPath: string
): Promise<{ frame: IgnorableStackFrame; source: string | null } | undefined> {
  let sourceURL = ensureFileUrl(frame.file) || frame.file
  // If we still don't have a scheme (relative like ".next/static/..."),
  // resolve it against the project root and turn it into a file:// URL
  if (!/^[a-zA-Z]+:\/\//.test(sourceURL)) {
    const abs = path.isAbsolute(sourceURL)
      ? sourceURL
      : path.join(projectPath, sourceURL.replace(/^[/\\]+/, ''))
    sourceURL = pathToFileURL(abs).href
  }

  const sourceMapPayload = await loadSourceMapPayload(project, sourceURL)
  if (sourceMapPayload !== undefined) {
    let consumer: SourceMapConsumer
    try {
      consumer = await new SourceMapConsumer(sourceMapPayload)
    } catch (cause) {
      throw new Error(
        `${sourceURL}: Invalid source map. Only conformant source maps can be used to find the original code.`,
        { cause }
      )
    }
    let traced: {
      originalPosition: NullableMappedPosition
      sourceContent: string | null
    } | null
    try {
      const originalPosition = consumer.originalPositionFor({
        line: frame.line ?? 1,
        // 0-based columns out requires 0-based columns in.
        column: (frame.column ?? 1) - 1,
      })

      if (originalPosition.source === null) {
        traced = null
      } else {
        const sourceContent: string | null =
          consumer.sourceContentFor(
            originalPosition.source,
            /* returnNullOnMissing */ true
          ) ?? null

        traced = { originalPosition, sourceContent }
      }
    } finally {
      consumer.destroy()
    }

    if (traced !== null) {
      const { originalPosition, sourceContent } = traced
      const applicableSourceMap = findApplicableSourceMapPayload(
        (frame.line ?? 1) - 1,
        (frame.column ?? 1) - 1,
        sourceMapPayload
      )

      // TODO(veil): Upstream a method to sourcemap consumer that immediately says if a frame is ignored or not.

      // 1) project-relative mapping (works for file:///C:/… and C:\…)
      const mappedFile = normalizeToProjectRelative(
        originalPosition.source!,
        projectPath
      )

      // 2) decide ignored
      let ignored = false
      if (applicableSourceMap === undefined) {
        console.error(
          'No applicable source map found in sections for frame',
          frame
        )
      } else {
        // TODO: O(n^2). Consider moving `ignoreList` into a Set

        const sourceIdx = applicableSourceMap.sources.indexOf(
          originalPosition.source!
        )
        ignored =
          (applicableSourceMap.ignoreList?.includes(sourceIdx) ?? false) ||
          // fallback (pages router/react-dom etc.)
          // shouldIgnorePath(frame.file)
          shouldIgnorePath(mappedFile)
      }

      // 3) collapse vendor frames to match webpack/mac
      if (
        /(^|[\\/])\.next([\\/])static([\\/])chunks([\\/]).*react-dom/i.test(
          frame.file
        ) ||
        /_compiled_react-dom/i.test(frame.file) ||
        /(^|\/)node_modules\//i.test(mappedFile)
      ) {
        ignored = true
      }

      const originalStackFrame: IgnorableStackFrame = {
        methodName:
          frame.methodName
            ?.replace('__WEBPACK_DEFAULT_EXPORT__', 'default')
            ?.replace('__webpack_exports__.', '') || '<unknown>',
        file: mappedFile,
        line1: originalPosition.line,
        column1:
          originalPosition.column === null ? null : originalPosition.column + 1,
        arguments: [],
        ignored,
      }

      return { frame: originalStackFrame, source: sourceContent }
    }
  }

  const guess = heuristicSourceFromChunkPath(frame.file)
  if (guess) {
    const mapped = normalizeToProjectRelative(guess, projectPath)
    return {
      frame: {
        methodName:
          frame.methodName
            ?.replace('__WEBPACK_DEFAULT_EXPORT__', 'default')
            ?.replace('__webpack_exports__.', '') || '<unknown>',
        file: mapped,
        line1: frame.line ?? null,
        column1: frame.column ?? null,
        arguments: [],
        ignored:
          /(^|\/)node_modules\//i.test(mapped) || shouldIgnorePath(mapped),
      },
      source: null,
    }
  }

  return undefined
}

async function createOriginalStackFrame(
  project: Project,
  projectPath: string,
  frame: TurbopackStackFrame
): Promise<OriginalStackFrameResponse | null> {
  const traced =
    (await nativeTraceSource(project, frame, projectPath)) ??
    (await batchedTraceSource(project, projectPath, frame))
  if (!traced) {
    return null
  }

  let normalizedStackFrameLocation = traced.frame.file
  if (
    normalizedStackFrameLocation &&
    normalizedStackFrameLocation.startsWith('.next/static/chunks/')
  ) {
    const guess = heuristicSourceFromChunkPath(normalizedStackFrameLocation)
    if (guess) {
      console.log(
        '[overlay] final guard mapped',
        normalizedStackFrameLocation,
        '->',
        guess
      )
      normalizedStackFrameLocation = guess
    }
    normalizedStackFrameLocation = normalizeToProjectRelative(
      normalizedStackFrameLocation,
      projectPath
    )
  }
  return {
    originalStackFrame: {
      arguments: traced.frame.arguments,
      file: normalizedStackFrameLocation,
      line1: traced.frame.line1,
      column1: traced.frame.column1,
      ignored: traced.frame.ignored,
      methodName: traced.frame.methodName,
    },
    originalCodeFrame: getOriginalCodeFrame(traced.frame, traced.source),
  }
}

export function getOverlayMiddleware({
  project,
  projectPath,
  isSrcDir,
}: {
  project: Project
  projectPath: string
  isSrcDir: boolean
}) {
  return async function (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): Promise<void> {
    const { pathname, searchParams } = new URL(req.url!, 'http://n')

    if (pathname === '/__nextjs_original-stack-frames') {
      if (req.method !== 'POST') {
        return middlewareResponse.badRequest(res)
      }

      const body = await new Promise<string>((resolve, reject) => {
        let data = ''
        req.on('data', (chunk) => {
          data += chunk
        })
        req.on('end', () => resolve(data))
        req.on('error', reject)
      })

      const request = JSON.parse(body) as OriginalStackFramesRequest
      const result = await getOriginalStackFrames({
        project,
        projectPath,
        frames: request.frames,
        isServer: request.isServer,
        isEdgeServer: request.isEdgeServer,
        isAppDirectory: request.isAppDirectory,
      })

      ignoreListAnonymousStackFramesIfSandwiched(result)

      return middlewareResponse.json(res, result)
    } else if (pathname === '/__nextjs_launch-editor') {
      const isAppRelativePath = searchParams.get('isAppRelativePath') === '1'

      let openEditorResult
      if (isAppRelativePath) {
        const relativeFilePath = searchParams.get('file') || ''
        const appPath = path.join(isSrcDir ? 'src' : '', relativeFilePath)
        openEditorResult = await openFileInEditor(appPath, 1, 1, projectPath)
      } else {
        const frame = createStackFrame(searchParams)
        if (!frame) return middlewareResponse.badRequest(res)
        openEditorResult = await openFileInEditor(
          frame.file,
          frame.line ?? 1,
          frame.column ?? 1,
          projectPath
        )
      }

      if (openEditorResult.error) {
        return middlewareResponse.internalServerError(
          res,
          openEditorResult.error
        )
      }
      if (!openEditorResult.found) {
        return middlewareResponse.notFound(res)
      }
      return middlewareResponse.noContent(res)
    }

    return next()
  }
}

export function getSourceMapMiddleware(project: Project) {
  return async function (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): Promise<void> {
    const { pathname, searchParams } = new URL(req.url!, 'http://n')

    if (pathname !== '/__nextjs_source-map') {
      return next()
    }

    let filename = searchParams.get('filename')

    if (!filename) {
      return middlewareResponse.badRequest(res)
    }

    let nativeSourceMap: SourceMap | undefined
    try {
      nativeSourceMap = findSourceMap(filename)
    } catch (cause) {
      return middlewareResponse.internalServerError(
        res,
        new Error(
          `${filename}: Invalid source map. Only conformant source maps can be used to find the original code.`,
          { cause }
        )
      )
    }

    if (nativeSourceMap !== undefined) {
      const sourceMapPayload = nativeSourceMap.payload
      return middlewareResponse.json(res, sourceMapPayload)
    }

    try {
      // Turbopack chunk filenames might be URL-encoded.
      filename = decodeURI(filename)
    } catch {
      return middlewareResponse.badRequest(res)
    }

    if (path.isAbsolute(filename)) {
      filename = pathToFileURL(filename).href
    }

    try {
      const sourceMapString = await project.getSourceMap(filename)

      if (sourceMapString) {
        return middlewareResponse.jsonString(res, sourceMapString)
      }
    } catch (cause) {
      return middlewareResponse.internalServerError(
        res,
        new Error(
          `Failed to get source map for '${filename}'. This is a bug in Next.js`,
          {
            cause,
          }
        )
      )
    }

    middlewareResponse.noContent(res)
  }
}

export async function getOriginalStackFrames({
  project,
  projectPath,
  frames,
  isServer,
  isEdgeServer,
  isAppDirectory,
}: {
  project: Project
  projectPath: string
  frames: readonly StackFrame[]
  isServer: boolean
  isEdgeServer: boolean
  isAppDirectory: boolean
}): Promise<OriginalStackFramesResponse> {
  const stackFrames = createStackFrames({
    frames,
    isServer,
    isEdgeServer,
    isAppDirectory,
  })

  return Promise.all(
    stackFrames.map(async (frame) => {
      try {
        const stackFrame = await createOriginalStackFrame(
          project,
          projectPath,
          frame
        )
        if (stackFrame === null) {
          return {
            status: 'rejected',
            reason: 'Failed to create original stack frame',
          }
        }
        return { status: 'fulfilled', value: stackFrame }
      } catch (error) {
        return {
          status: 'rejected',
          reason: inspect(error, { colors: false }),
        }
      }
    })
  )
}
