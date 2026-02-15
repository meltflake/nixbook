# Luca's EPUB Reader - 技术方案大纲

## 1. 项目定位

- 自用网页版 EPUB 阅读器
- 主要阅读英文书籍
- PWA 离线优先

## 2. 核心功能模块

| 模块 | 功能 |
|------|------|
| 阅读器 | EPUB 解析、渲染、翻页 |
| 标注 | 画线、高亮、导出 |
| 词典 | 长按查词、离线词库 |
| 存储 | 书籍、标注、进度本地化 |
| 离线 | Service Worker + PWA |

## 3. 技术选型

### 前端框架

- 纯 Vanilla JS 或 Svelte（轻量）
- 不推荐 React/Vue（overkill）

### EPUB 渲染

- foliate-js（首选，现代、轻量）
- 备选：epub.js

### 标注系统

- 数据格式：Web Annotation Data Model 或自定义 JSON
- 存储：IndexedDB（本地）
- 导出：Markdown / JSON / HTML

### 离线词典

- 词库：ECDICT（简明英汉）~3MB 压缩
- 备选：WordNet（英英）
- 存储：IndexedDB，首次加载后离线可用

### 离线 / PWA

- Service Worker：Workbox
- 缓存策略：Cache First（静态资源 + 词库）
- manifest.json：可安装到桌面

### 本地存储

- IndexedDB（主力）：书籍文件、标注、词库
- localStorage：阅读进度、偏好设置

## 4. 数据结构（草案）

```typescript
// 书籍
interface Book {
  id: string
  title: string
  author: string
  file: Blob  // EPUB 文件
  addedAt: number
  lastReadAt: number
  progress: number  // 0-1
}

// 标注
interface Annotation {
  id: string
  bookId: string
  cfi: string  // EPUB CFI 定位
  text: string  // 原文
  note?: string  // 批注
  color: string
  createdAt: number
}

// 词典条目
interface DictEntry {
  word: string
  phonetic?: string
  definition: string
  translation?: string
}
```

## 5. 页面结构

```
/
├── index.html      # 书架
├── reader.html     # 阅读器
└── export.html     # 导出标注
```

## 6. 开发路线（MVP）

### Phase 1 - 能读

- [ ] EPUB 上传 + 解析
- [ ] 基础阅读界面
- [ ] 翻页 / 进度保存

### Phase 2 - 能标

- [ ] 文本选中 → 高亮
- [ ] 标注列表查看
- [ ] 导出为 Markdown

### Phase 3 - 能查

- [ ] 长按选词
- [ ] 弹出词典卡片
- [ ] 离线词库加载

### Phase 4 - 能离线

- [ ] Service Worker
- [ ] PWA manifest
- [ ] 安装提示

## 7. 部署

- 静态托管：Cloudflare Pages / Vercel / GitHub Pages
- 零后端，纯前端
