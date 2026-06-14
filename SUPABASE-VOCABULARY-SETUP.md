# 单词学习卡 Edge Function 部署

前端不会保存 OpenAI 密钥。家长页面的“自动生成学习卡”会调用 Supabase Edge Function。

## 一次性设置

1. 在 OpenAI API 平台创建 API key。ChatGPT 订阅不包含 API 额度，需要为 API 账户启用计费。
2. 安装并登录 Supabase CLI。
3. 在本项目目录执行：

```bash
supabase link --project-ref gpuioangxzjzihqjdmyf
supabase secrets set OPENAI_API_KEY=你的OpenAI密钥
supabase secrets set OPENAI_MODEL=gpt-4.1-mini
supabase functions deploy generate-vocabulary-cards
```

Supabase 会自动向函数提供 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`。函数只允许已登录的家长账号调用。

## 更新函数

修改 `supabase/functions/generate-vocabulary-cards/index.ts` 后重新运行：

```bash
supabase functions deploy generate-vocabulary-cards
```

不要把真实 OpenAI key 写进 `.env.example`、`supabase-config.js` 或 GitHub 仓库。
