#!/usr/bin/env node
/**
 * 样式预检（wxss + wxml）
 *
 * 为什么需要这个：原有校验三件套只覆盖 JS 语法、页面注册、包体积，
 * 完全不看 wxss。结果 app.wxss 的注释里混进一个 Markdown 反引号，
 * 一路提交推送，直到点「发布」才被微信编译器打回：
 *     app.wxss:1663:12: error at token ``
 *
 * 这里查的都是「编译期必炸」或「静默失效」的问题：
 *   1. 反引号 —— wxss 不支持，编译直接报错
 *   2. Markdown 残留 **粗体** —— 通常是从文档里粘注释带进来的
 *   3. 注释 / 花括号配对
 *   4. 去注释后仍有全角标点 —— 属性名或值里出现必炸
 *   5. {{ }} 模板语法残留在样式里
 *   6. var(--x) 引用了从未定义的变量 —— 不报错，但整条样式静默失效
 *   7. 选择器里的通配符 * —— WXSS 不支持，编译报 error at token '*'
 *      （真事：.stagger > *:nth-child(n) 让整个包发布失败两次）
 *   8. wxml 里 {{ }} 与反引号
 *
 * 用法：node tools/style-lint.js [项目根目录]
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const SKIP = new Set(['node_modules', 'miniprogram_npm', '.git', '.agents', 'tools', 'docs'])

function walk(dir, ext, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, ext, out)
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

// 全角标点：出现在注释之外一律视为错误（属性名/值里不可能合法）
const FULLWIDTH = /[：；，（）【】“”‘’、]/

const problems = []

function report(file, line, msg, snippet) {
  problems.push({ file, line, msg, snippet })
}

function lintWxss(file, src) {
  const lines = src.split('\n')

  // 1) 逐行扫字符级问题（注释里也不行 —— 微信编译器会报错）
  lines.forEach((text, i) => {
    if (text.indexOf('`') !== -1) {
      report(file, i + 1, '反引号 ` —— wxss 不支持，编译报 error at token', text.trim())
    }
    if (text.indexOf('**') !== -1) {
      report(file, i + 1, 'Markdown 粗体 ** —— 疑似从文档粘贴的注释', text.trim())
    }
    if (/\{\{|\}\}/.test(text)) {
      report(file, i + 1, '模板语法 {{ }} 出现在样式文件里', text.trim())
    }
  })

  // 2) 注释配对
  const open = (src.match(/\/\*/g) || []).length
  const close = (src.match(/\*\//g) || []).length
  if (open !== close) {
    report(file, 0, `注释不配对：/* ${open} 个，*/ ${close} 个`, '')
  }

  // 3) 去掉注释后查结构
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  let depth = 0
  bare.split('\n').forEach((text, i) => {
    for (const ch of text) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (FULLWIDTH.test(text)) {
      report(file, i + 1, '全角标点（且不在注释里）—— 选择器/属性里必炸', text.trim())
    }
  })
  if (depth !== 0) {
    report(file, 0, `花括号不配对，最终层级 ${depth}（正数为缺 }）`, '')
  }

  // 4) 选择器合法性：WXSS 不支持通配符 *
  bare.split('\n').forEach((text, i) => {
    const code = text.trim()
    if (!code || code.startsWith('@')) return
    const sel = code.split('{')[0]
    if (!sel) return
    // 先剥掉括号内（nth-child 里的 n + 11 这类运算）与方括号内（属性选择器的值）
    const scrubbed = sel.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '')
    if (scrubbed.indexOf('*') !== -1) {
      report(file, i + 1,
        "选择器里出现通配符 * —— WXSS 不支持，编译报 error at token '*'", code)
    }
    if (/[+~]/.test(scrubbed)) {
      report(file, i + 1, '选择器用了兄弟选择器 + / ~ —— WXSS 官方不支持，改用 class', code)
    }
  })
}

function main() {
  const wxssFiles = walk(ROOT, '.wxss', [])
  const wxmlFiles = walk(ROOT, '.wxml', [])

  // ---- 收集全部 CSS 变量定义，跨文件共享（页面样式用 app.wxss 里的变量是正常的）
  const defined = new Set()
  const contents = new Map()
  for (const f of wxssFiles) {
    const src = fs.readFileSync(f, 'utf8')
    contents.set(f, src)
    for (const m of src.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1])
  }

  for (const f of wxssFiles) {
    const src = contents.get(f)
    lintWxss(rel(f), src)

    // var(--x) 引用的变量必须至少被定义过一次
    const lines = src.split('\n')
    lines.forEach((text, i) => {
      for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g)) {
        const name = m[1]
        const hasFallback = !!m[2]
        if (!defined.has(name) && !hasFallback) {
          report(rel(f), i + 1, `引用了未定义的变量 ${name} —— 整条样式会静默失效`, text.trim())
        }
      }
    })
  }

  // ---- wxml：反引号、插值配对
  for (const f of wxmlFiles) {
    const src = fs.readFileSync(f, 'utf8')
    src.split('\n').forEach((text, i) => {
      if (text.indexOf('`') !== -1) {
        report(rel(f), i + 1, '反引号 ` —— wxml 表达式不支持模板字符串', text.trim())
      }
    })
    const o = (src.match(/\{\{/g) || []).length
    const c = (src.match(/\}\}/g) || []).length
    if (o !== c) {
      report(rel(f), 0, `{{ }} 不配对：{{ ${o} 个，}} ${c} 个`, '')
    }
  }

  // ---- 输出
  console.log(`样式预检：${wxssFiles.length} 个 wxss，${wxmlFiles.length} 个 wxml，共定义 ${defined.size} 个 CSS 变量`)

  if (!problems.length) {
    console.log('  [OK]   无语法错误、无未定义变量')
    return 0
  }

  const byFile = new Map()
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, [])
    byFile.get(p.file).push(p)
  }
  for (const [file, list] of byFile) {
    console.log(`\n  [FAIL] ${file}`)
    for (const p of list) {
      const head = p.line ? `L${p.line}  ` : ''
      console.log(`     ${head}${p.msg}`)
      if (p.snippet) console.log(`           > ${p.snippet.slice(0, 90)}`)
    }
  }
  console.log(`\n共 ${problems.length} 处问题，发布前必须修掉。`)
  return 1
}

process.exit(main())
