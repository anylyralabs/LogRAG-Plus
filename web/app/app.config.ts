/**
 * Nuxt UI 主题。
 *
 * **配色不做任何覆盖**——沿用 Nuxt UI 默认（green / slate / red / yellow）。
 *
 * 圆角也不在这里配：`radius` 不是 `AppConfigUI` 的合法字段（实测 vue-tsc 报
 * TS2353）。圆角通过 CSS 变量 `--ui-radius` 设，见 `assets/css/main.css`。
 */
export default defineAppConfig({})
