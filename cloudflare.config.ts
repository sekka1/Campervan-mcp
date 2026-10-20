import { bindings, defineConfig } from "cf/config";

const isLocalDev =
  process.env.LOCAL_DEV === "true" ||
  process.env.SKIP_REMOTE_AI === "true" ||
  process.env.CI_SMOKE_TEST === "true";

export default defineConfig({
	worker: {
		name: "campervan-mcp-server",
		compatibilityDate: "2026-07-01",
		entrypoint: "src/index.ts",
		env: {
			ENVIRONMENT: bindings.text("production"),
			CDN_BASE_URL: bindings.text(""),
			AUTH_ENABLED: bindings.text("false"),
			METERING_ALLOW_ALL: bindings.text("true"),
			DB: bindings.d1({
				name: "van_specs_db",
				id: "2aa73cfb-cf41-4ab3-b614-b0cf1eb7ec0c",
			}),
			VECTOR_INDEX: bindings.vectorize({
				name: "van_manuals_index",
			}),
			...(isLocalDev ? {} : { AI: bindings.ai() }),
		},
	},
});
