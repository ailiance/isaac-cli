import type { StackSnapshot } from "@shared/proto/isaac/stack"
import { create } from "zustand"

interface StackState {
	snapshot: StackSnapshot | null
	loading: boolean
	error: string | null
	lastRefreshedAt: number | null

	setSnapshot: (snapshot: StackSnapshot) => void
	setLoading: (loading: boolean) => void
	setError: (error: string | null) => void
}

export const useStackStore = create<StackState>((set) => ({
	snapshot: null,
	loading: false,
	error: null,
	lastRefreshedAt: null,

	setSnapshot: (snapshot) => set({ snapshot, lastRefreshedAt: Date.now(), error: null }),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),
}))
