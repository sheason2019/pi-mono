export function formatRunDuration(durationMs: number, reason?: "completed" | "interrupted" | "error"): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const suffix = reason === "interrupted" ? "（已中断）" : reason === "error" ? "（异常结束）" : "";
	return `本轮用时: ${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s${suffix}`;
}
