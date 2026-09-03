---
name: news-digest
description: 每天早上抓取指定信源，生成一份精简资讯摘要
triggers:
  - "/news-digest"
  - "今天有什么新闻"
model_hint: claude-sonnet-5
effort_hint: medium
---

## 这个 Skill 做什么
1. 从 areas/CONTENT.md 里列出的信源清单抓取当日更新
2. 用统一格式（标题+一句话+链接）整理成摘要
3. 写入 output/artifacts/news/YYYY-MM-DD.md
4. 追加一行记录到 runs.log

## 绝对不能做的事（护栏）
- 不自动转发/发布到任何外部平台
- 不访问 areas/CONTENT.md 之外声明的信源
- 抓取失败的信源要在摘要里明确标注"未获取"，不要编造内容

## 需要人工确认的动作
（本 skill 无高风险动作，全程只读）

## 依赖的 Application
- fetch-cli（connectors/fetch-cli，见 Application 层）
