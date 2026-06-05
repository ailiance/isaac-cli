import { EmptyRequest } from "@shared/proto/isaac/common"
import { useCallback, useEffect, useRef } from "react"
import { UiServiceClient } from "@/shared/api/grpc-client"

export const useRelinquishControl = () => {
	const relinquishControlCallbacks = useRef<Set<() => void>>(new Set())

	const onRelinquishControl = useCallback((callback: () => void) => {
		relinquishControlCallbacks.current.add(callback)
		return () => {
			relinquishControlCallbacks.current.delete(callback)
		}
	}, [])

	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToRelinquishControl(EmptyRequest.create({}), {
			onResponse: () => {
				relinquishControlCallbacks.current.forEach((callback) => {
					callback()
				})
			},
			onError: (error) => {
				console.error("Error in relinquishControl subscription:", error)
			},
			onComplete: () => {},
		})

		return cleanup
	}, [])

	return onRelinquishControl
}
