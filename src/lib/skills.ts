export interface SkillDef {
  name: string;
  desc: string;
}

export interface SkillCategory {
  key: string;
  label: string;
  skills: SkillDef[];
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  {
    key: "dev",
    label: "开发",
    skills: [
      { name: "commit", desc: "创建规范的 Git 提交" },
      { name: "init", desc: "初始化 CLAUDE.md" },
      { name: "review", desc: "审查 Pull Request" },
      { name: "code-review", desc: "代码审查 PR" },
      { name: "security-review", desc: "安全审查当前分支" },
      { name: "simplify", desc: "精简和优化代码" },
    ],
  },
  {
    key: "claude",
    label: "Claude Code",
    skills: [
      { name: "update-config", desc: "配置 settings.json" },
      { name: "keybindings-help", desc: "自定义快捷键" },
      { name: "less-permission-prompts", desc: "减少权限弹窗" },
      { name: "loop", desc: "循环执行任务" },
      { name: "schedule", desc: "定时执行远程代理" },
      { name: "claude-api", desc: "构建 Claude API 应用" },
      { name: "claude-code-setup", desc: "分析并推荐自动化配置" },
    ],
  },
  {
    key: "lark",
    label: "飞书",
    skills: [
      { name: "lark-shared", desc: "认证与基础配置" },
      { name: "lark-im", desc: "即时通讯 · 收发消息" },
      { name: "lark-doc", desc: "云文档 · 创建编辑" },
      { name: "lark-drive", desc: "云空间 · 文件管理" },
      { name: "lark-base", desc: "多维表格 · 数据管理" },
      { name: "lark-sheets", desc: "电子表格 · 读写操作" },
      { name: "lark-calendar", desc: "日历 · 日程管理" },
      { name: "lark-task", desc: "任务 · 待办清单" },
      { name: "lark-contact", desc: "通讯录 · 组织架构" },
      { name: "lark-mail", desc: "邮箱 · 收发邮件" },
      { name: "lark-event", desc: "事件订阅 · 实时监听" },
      { name: "lark-vc", desc: "视频会议 · 会议纪要" },
      { name: "lark-minutes", desc: "妙记 · AI 总结" },
      { name: "lark-whiteboard", desc: "画板 · 绘制图表" },
      { name: "lark-wiki", desc: "知识库 · 文档节点" },
      { name: "lark-openapi-explorer", desc: "探索原生 OpenAPI" },
      { name: "lark-skill-maker", desc: "创建自定义 Skill" },
      { name: "lark-workflow-meeting-summary", desc: "会议纪要整理" },
      { name: "lark-workflow-standup-report", desc: "日程待办摘要" },
    ],
  },
  {
    key: "doc",
    label: "文档",
    skills: [
      { name: "document-skills:pdf", desc: "PDF 创建与编辑" },
      { name: "document-skills:docx", desc: "Word 文档处理" },
      { name: "document-skills:xlsx", desc: "Excel 表格处理" },
      { name: "document-skills:pptx", desc: "PPT 演示文稿" },
      { name: "document-skills:canvas-design", desc: "视觉设计 · PNG/PDF" },
      { name: "document-skills:frontend-design", desc: "高质量前端界面" },
      { name: "document-skills:web-artifacts-builder", desc: "HTML 组件构建" },
      { name: "document-skills:doc-coauthoring", desc: "文档协作撰写" },
      { name: "document-skills:internal-comms", desc: "内部通讯撰写" },
      { name: "document-skills:brand-guidelines", desc: "品牌设计规范" },
      { name: "document-skills:theme-factory", desc: "主题样式工具" },
      { name: "document-skills:skill-creator", desc: "创建新 Skill" },
      { name: "document-skills:mcp-builder", desc: "构建 MCP 服务器" },
      { name: "document-skills:algorithmic-art", desc: "算法艺术 · p5.js" },
      { name: "document-skills:slack-gif-creator", desc: "Slack GIF 动画" },
      { name: "document-skills:webapp-testing", desc: "Web 应用测试" },
    ],
  },
  {
    key: "other",
    label: "其他",
    skills: [
      { name: "ui-ux-pro-max", desc: "UI/UX 设计智能" },
      { name: "frontend-design:frontend-design", desc: "前端界面设计" },
      { name: "dm-dashboard", desc: "Dashboard 前端编码" },
      { name: "dmbi-cli", desc: "广告平台 BI 查询" },
      { name: "volcengine-web-search", desc: "火山引擎联网搜索" },
    ],
  },
];
