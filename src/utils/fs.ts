import { workspaceResolver } from "@core/workspace"
import fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"

const IS_WINDOWS = /^win/.test(process.platform)

/**
 * Asynchronously creates all non-existing subdirectories for a given file path
 * and collects them in an array for later deletion.
 *
 * @param filePath - The full path to a file.
 * @returns A promise that resolves to an array of newly created directories.
 */
export async function createDirectoriesForFile(filePath: string): Promise<string[]> {
	const newDirectories: string[] = []
	const normalizedFilePath = path.normalize(filePath) // Normalize path for cross-platform compatibility
	const directoryPath = path.dirname(normalizedFilePath)

	let currentPath = directoryPath
	const dirsToCreate: string[] = []

	// Traverse up the directory tree and collect missing directories
	while (!(await fileExistsAtPath(currentPath))) {
		dirsToCreate.push(currentPath)
		currentPath = path.dirname(currentPath)
	}

	// Create directories from the topmost missing one down to the target directory
	for (let i = dirsToCreate.length - 1; i >= 0; i--) {
		await fs.mkdir(dirsToCreate[i])
		newDirectories.push(dirsToCreate[i])
	}

	return newDirectories
}

/**
 * Helper function to check if a path exists.
 *
 * @param path - The path to check.
 * @returns A promise that resolves to true if the path exists, false otherwise.
 */
/**
 * Helper to check if an error indicates that a file or directory was not found.
 */
function isNotFound(error: any): boolean {
	return error.code === "ENOENT"
}

function isNotADirectory(error: any): boolean {
	return error.code === "ENOTDIR"
}


export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch (error: any) {
		if (isNotFound(error) || isNotADirectory(error)) {
			return false
		}
		throw error
	}
}

/**
 * Checks if the path is a directory
 * @param filePath - The path to check.
 * @returns A promise that resolves to true if the path is a directory, false otherwise.
 */
export async function isDirectory(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(filePath)
		return stats.isDirectory()
	} catch (error: any) {
		if (isNotFound(error) || isNotADirectory(error)) {
			return false
		}
		throw error
	}
}

/**
 * Gets the size of a file in kilobytes
 * @param filePath - Path to the file to check
 * @returns Promise<number> - Size of the file in KB, or 0 if file doesn't exist
 */
export async function getFileSizeInKB(filePath: string): Promise<number> {
	try {
		const stats = await fs.stat(filePath)
		const fileSizeInKB = stats.size / 1000 // Convert bytes to KB (decimal) - matches OS file size display
		return fileSizeInKB
	} catch (error: any) {
		if (isNotFound(error) || isNotADirectory(error)) {
			return 0
		}
		throw error
	}
}

/**
 * Writes content to a file
 * @param filePath - Absolute path to the file
 * @param content - Content to write (string or Uint8Array)
 * @param encoding - Text encoding (default: 'utf8')
 * @returns A promise that resolves when the file is written
 */
export async function writeFile(
	filePath: string,
	content: string | Uint8Array,
	encoding: BufferEncoding = "utf8",
): Promise<void> {
	if (content instanceof Uint8Array) {
		await fs.writeFile(filePath, content)
	} else {
		await fs.writeFile(filePath, content, encoding)
	}
}

/** Maximum number of nested directories `ensureParentDirectory` will create. */
export const MKDIR_MAX_DEPTH = 10

/**
 * Ensures the parent directory of `filePath` exists, creating intermediate directories
 * if needed. Throws a clear error if the parent cannot be created (permissions, etc.)
 * or if the depth of missing directories to create exceeds {@link MKDIR_MAX_DEPTH}.
 */
export async function ensureParentDirectory(filePath: string): Promise<void> {
	const normalized = path.normalize(filePath)
	const parent = path.dirname(normalized)

	// Walk up to find missing directories (cap depth to avoid pathological inputs)
	let cursor = parent
	let missing = 0
	while (!(await fileExistsAtPath(cursor))) {
		missing++
		if (missing > MKDIR_MAX_DEPTH) {
			throw new Error(
				`Cannot create parent directory ${parent}: refusing to create more than ${MKDIR_MAX_DEPTH} nested directories.`,
			)
		}
		const next = path.dirname(cursor)
		if (next === cursor) {
			break
		}
		cursor = next
	}

	if (missing === 0) {
		return
	}

	try {
		await fs.mkdir(parent, { recursive: true })
	} catch (error: any) {
		throw new Error(`Cannot create parent directory ${parent}: ${error?.message ?? String(error)}`)
	}
}

/**
 * Atomically writes `content` to `filePath` using a temp-file + rename strategy:
 *
 *   1. Write to `<filePath>.tmp.<pid>.<random>` first.
 *   2. `fs.rename` to the final path (atomic on the same filesystem on POSIX).
 *   3. On failure, attempt to remove the tmp file.
 *
 * The parent directory must already exist — call {@link ensureParentDirectory}
 * before this if needed.
 */
export async function atomicWriteFile(
	filePath: string,
	content: string | Uint8Array,
	encoding: BufferEncoding = "utf8",
): Promise<void> {
	const random = Math.floor(Math.random() * 0xffffff)
		.toString(16)
		.padStart(6, "0")
	const tmpPath = `${filePath}.tmp.${process.pid}.${random}`

	try {
		if (content instanceof Uint8Array) {
			await fs.writeFile(tmpPath, content)
		} else {
			await fs.writeFile(tmpPath, content, encoding)
		}
		await fs.rename(tmpPath, filePath)
	} catch (error) {
		// Best-effort cleanup; swallow ENOENT (tmp may not exist yet)
		try {
			await fs.unlink(tmpPath)
		} catch {
			/* ignore */
		}
		throw error
	}
}

// Common OS-generated files that would appear in an otherwise clean directory
const OS_GENERATED_FILES = [
	".DS_Store", // macOS Finder
	"Thumbs.db", // Windows Explorer thumbnails
	"desktop.ini", // Windows folder settings
]

/**
 * Recursively reads a directory and returns an array of absolute file paths.
 *
 * @param directoryPath - The path to the directory to read.
 * @param excludedPaths - Nested array of paths to ignore.
 * @returns A promise that resolves to an array of absolute file paths.
 * @throws Error if the directory cannot be read.
 */
export const readDirectory = async (directoryPath: string, excludedPaths: string[][] = []) => {
	try {
		const filePaths = await fs
			.readdir(directoryPath, { withFileTypes: true, recursive: true })
			.then((entries) => entries.filter((entry) => !OS_GENERATED_FILES.includes(entry.name)))
			.then((entries) => entries.filter((entry) => entry.isFile()))
			.then((files) =>
				files.map((file) => {
					const resolvedPath = workspaceResolver.resolveWorkspacePath(
						file.parentPath,
						file.name,
						"Utils.fs.readDirectory",
					)
					return typeof resolvedPath === "string" ? resolvedPath : resolvedPath.absolutePath
				}),
			)
			.then((filePaths) =>
				filePaths.filter((filePath) => {
					if (excludedPaths.length === 0) {
						return true
					}

					for (const excludedPathList of excludedPaths) {
						const pathToSearchFor = path.sep + excludedPathList.join(path.sep) + path.sep
						if (filePath.includes(pathToSearchFor)) {
							return false
						}
					}

					return true
				}),
			)

		return filePaths
	} catch (error: any) {
		throw new Error(`Error reading directory at ${directoryPath}: ${error.message || error.code || error}`)
	}
}

export async function getBinaryLocation(name: string): Promise<string> {
	const binName = IS_WINDOWS ? `${name}.exe` : name
	const location = await HostProvider.get().getBinaryLocation(binName)

	if (!(await fileExistsAtPath(location))) {
		throw new Error(`Could not find binary ${name} at: ${location}`)
	}
	return location
}
