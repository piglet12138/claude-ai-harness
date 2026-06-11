# 打赏 / 收款码

入口在 **设置 → 支持** tab（不在主页面，仅登录用户可见）。

把收款码图片放这里，文件名固定：

- `alipay.png` — 支付宝收款码（当前启用）
- `wechat.png` — 微信（如以后要加，前端目前只读 alipay）

建议白底、QR 清晰，竖版导出也行（前端按宽 240px 等比缩放）。未上传时优雅降级为占位提示，不报错。

## ⚠️ 这些图片不进 Git（仓库是 public）

`*.png / *.jpg` 已在 `.gitignore` 忽略，**不会提交到公开仓库**，避免个人收款码暴露在 GitHub。

部署到 prod 时**单独把图片传到服务器**（`git pull` 不会动这个未跟踪文件，所以传一次即长期生效）：

```bash
scp public/donate/alipay.png root@167.71.197.117:/root/claude-docs-candidates/claude-lite/public/donate/
```
