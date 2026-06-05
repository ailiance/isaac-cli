import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Empty } from "@shared/proto/isaac/common"
import { UpdateJinaRoutesRequest } from "@shared/proto/isaac/stack"
import type { Controller } from "../index"

const ROUTES_PATH = path.join(os.homedir(), ".isaac", "jina-router", "routes.json")

/**
 * Writes updated Jina router route definitions to the routes.json config file.
 */
export async function updateJinaRoutes(_controller: Controller, request: UpdateJinaRoutesRequest): Promise<Empty> {
	const data: Record<string, { examples: string[]; preferred_model: string }> = {}
	for (const route of request.routes) {
		data[route.category] = {
			examples: route.examples,
			preferred_model: route.preferredModel,
		}
	}
	await fs.mkdir(path.dirname(ROUTES_PATH), { recursive: true })
	await fs.writeFile(ROUTES_PATH, JSON.stringify(data, null, 2), "utf8")
	return {}
}
