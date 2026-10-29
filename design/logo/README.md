# hazejs logo

无底色图形：小写 h 用品牌渐变（`#7a6bff → #30a9e4`）绘制，右腿不落地，化作两道逐渐变淡、向右漂移的起伏雾带——"haze" 本身。
没有色块底，因此能直接融进文档站首页的光晕，也能放在任意深浅背景上。

打开 `preview.html` 查看 128 / 64 / 32 / 16 四档尺寸与横排组合在浅色、深色底下的效果（`preview.png` 为截图）；`preview-nobg.html` 是在模拟首页光晕上的四个候选对比。

## 文件

| 文件 | 说明 |
| --- | --- |
| `haze-logo.svg` | **主 logo**。与 `docs/public/logo.svg` 相同，用于 favicon、导航栏、首页 hero、社交头像。 |
| `haze-lockup.svg` | 横排组合：主 logo + "hazejs" 字标。字标用 `currentColor`，在 `<img>` 里默认深色，内嵌时通过 `color` 切换深浅底；"js" 为品牌渐变。 |
| `haze-mark.svg` | 带色块底的版本（深色底 + 渐变 h，外沿 10% 白描边）。适合需要方形图标的场景：应用图标、社交平台头像。 |
| `haze-mark-light.svg` | 带色块底的浅色版（靛紫径向渐变 + 白 h）。 |
| `haze-mark-plain.svg` | 早期"消散的 h"图形透明底版本（雾带为直线）。 |
| `alt-b-sun-in-haze.svg` / `-plain.svg` | 早期备选 B · 雾中日轮。 |
| `alt-c-drifting-layers.svg` | 早期备选 C · 漂移雾层。 |

注意：`haze-lockup.svg` 的字标是 `<text>`（Inter，回退系统无衬线）。用于印刷或对字体一致性要求高的场景前，请在 Figma / Illustrator 里转为轮廓。
