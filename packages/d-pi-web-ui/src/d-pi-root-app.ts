import { html, LitElement, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { getRootAppView } from "./app-router.js";
import "./d-pi-public-org.js";
import "./d-pi-web-app.js";

@customElement("d-pi-root-app")
export class DPiRootApp extends LitElement {
	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override render(): TemplateResult {
		const pathname = globalThis.location?.pathname ?? "/";
		const search = globalThis.location?.search ?? "";
		return getRootAppView(pathname, search) === "agent-ui"
			? html`<d-pi-web-app></d-pi-web-app>`
			: html`<d-pi-public-org></d-pi-public-org>`;
	}
}
