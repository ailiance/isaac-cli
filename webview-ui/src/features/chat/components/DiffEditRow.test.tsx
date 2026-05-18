import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { DiffStructure } from "@shared/utils/diff/DiffStructure"
import { DiffEditRow } from "./DiffEditRow"

// Mock the gRPC FileServiceClient: it's not relevant to render assertions and
// would otherwise pull the proto runtime into jsdom.
vi.mock("@/shared/api/grpc-client", () => ({
	FileServiceClient: {
		openFileRelativePath: vi.fn(() => Promise.resolve()),
	},
}))

describe("DiffEditRow", () => {
	describe("structured path (hunks prop)", () => {
		const hunks: DiffStructure = {
			path: "src/foo.ts",
			totalAdditions: 1,
			totalDeletions: 1,
			blocks: [
				{
					additions: 1,
					deletions: 1,
					lines: [
						{ type: "context", content: "const a = 1", oldLineNumber: 1, newLineNumber: 1 },
						{ type: "remove", content: "const b = 2", oldLineNumber: 2 },
						{ type: "add", content: "const b = 42", newLineNumber: 2 },
					],
				},
			],
		}

		it("renders typed lines from the structured diff and bypasses the patch parser", () => {
			render(<DiffEditRow hunks={hunks} isHeadless={true} patch="this content should be ignored" path="src/foo.ts" />)

			// Removed and added contents are rendered as-is, no +/- prefix in the content span.
			expect(screen.getByText("const a = 1")).toBeInTheDocument()
			expect(screen.getByText("const b = 2")).toBeInTheDocument()
			expect(screen.getByText("const b = 42")).toBeInTheDocument()
		})

		it("singular vs plural in the summary tooltip", () => {
			render(<DiffEditRow hunks={hunks} isHeadless={true} patch="" path="src/foo.ts" />)
			const summary = screen.getByTestId("diff-summary")
			expect(summary.getAttribute("title")).toBe("Added 1 line, removed 1 line")
		})
	})

	describe("legacy fallback (no hunks)", () => {
		it("falls back to parsePatch when hunks is omitted", () => {
			const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@
- old line
+ new line
*** End Patch`
			render(<DiffEditRow isHeadless={true} patch={patch} path="src/foo.ts" />)

			// The legacy renderer strips the +/- prefix into a separate span; the code
			// content is rendered verbatim.
			expect(screen.getByText("old line")).toBeInTheDocument()
			expect(screen.getByText("new line")).toBeInTheDocument()
		})
	})
})
