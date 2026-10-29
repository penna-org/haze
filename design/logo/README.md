# hazejs logo

圆角方块底（64 视口，`rx=16`）+ 小写 h。h 的右腿不落地，化作三层逐渐变宽、变淡、向右漂移的雾带——"haze" 本身；也暗合同一个 h 之下多层运行时（Node / Bun / Deno / edge）层层延展。

打开 `preview.html` 可查看 128 / 64 / 32 / 16 四档尺寸在浅色与深色底下的效果（`preview.png` 为截图）；`preview-backgrounds.html` 保留了 8 组背景配色的对比。

## 文件

| 文件 | 说明 |
| --- | --- |
| `haze-mark.svg` | **主图标**。深色底 `#1d1e3c → #101128`，h 为渐变 `#9b8cff → #4fc3f7`，外沿一圈 10% 白描边保证在深色页面上仍有边缘。用于 favicon、文档站 logo、社交头像。 |
| `haze-mark-light.svg` | 浅色备选。靛紫径向渐变底（`#948aff` 高光 → `#4f3fdc`）+ 白色 h。适合需要亮色块的场景（如彩色徽章、启动画面）。 |
| `haze-mark-plain.svg` | 透明底，笔画为渐变色。用于浅色页面内嵌、README 顶部。 |
| `haze-lockup.svg` | 横排组合：主图标 + "hazejs" 字标。字标用 `currentColor`，在 `<img>` 里默认深色，内嵌时通过 `color` 切换深浅底；"js" 为品牌渐变。 |
| `alt-b-sun-in-haze.svg` / `-plain.svg` | 早期备选 B · 雾中日轮（抽象、无字母）。 |
| `alt-c-drifting-layers.svg` | 早期备选 C · 漂移雾层（几何横带）。 |

注意：`haze-lockup.svg` 的字标是 `<text>`（Inter，回退系统无衬线）。用于印刷或对字体一致性要求高的场景前，请在 Figma / Illustrator 里转为轮廓。

## 替换文档站 logo

```bash
cp design/logo/haze-mark.svg docs/public/logo.svg
```
