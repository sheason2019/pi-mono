export type RootAppView = "public-org" | "agent-ui";

export const PUBLIC_ORG_ENDPOINT = "/api/public/org";

export function getRootAppView(pathname: string, search = ""): RootAppView {
	const token = new URLSearchParams(search).get("token")?.trim();
	if ((pathname === "/" || pathname === "/index.html") && token) {
		return "agent-ui";
	}
	return /^\/agents\/[^/]+\/?$/.test(pathname) ? "agent-ui" : "public-org";
}
