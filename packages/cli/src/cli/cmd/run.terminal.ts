type Emit = (type: string, data: Record<string, unknown>) => unknown

export function terminal(emit: Emit) {
  const state = {
    complete: false,
    error: false,
  }

  return {
    complete(data: Record<string, unknown>) {
      if (state.complete) return
      state.complete = true
      emit("session_complete", data)
    },
    error(data: Record<string, unknown>) {
      if (state.complete || state.error) return
      state.error = true
      emit("session_error", data)
    },
  }
}
