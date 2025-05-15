import * as fs from 'fs'
import * as path from 'path'
import { TextDocument, window, Position, OutputChannel } from 'vscode'
import { quickParseStyle } from './quickParseStle'
import { Config } from './config'
import { getRoot } from './helper'
import loadScss from './loadScss'
import { isScssFile, parseScssBem } from './PostcssBemParser'

// 获取或创建输出通道
let outputChannel: OutputChannel | null = null;
function getOutputChannel(): OutputChannel {
  if (!outputChannel) {
    outputChannel = window.createOutputChannel('Minapp Style Debug');
  }
  return outputChannel;
}

// 日志函数
function log(message: string): void {
  const channel = getOutputChannel();
  const logMessage = `[MINIAPP-DEBUG] ${message}`;
  console.log(logMessage);
  channel.appendLine(logMessage);
}

export interface Style {
  name: string
  pos: Position
  doc: string
}

export interface StyleFile {
  file: string
  styles: Style[]
}

const fileCache: { [file: string]: { mtime: Date; value: StyleFile } } = {}

function isScss(file: string): boolean {
  return /\.s[ac]ss/.test(file)
}

export function parseStyleFile(file: string) {
  log(`解析样式文件: ${file}`);
  try {
    let cache = fileCache[file]
    const editor = window.visibleTextEditors.find(e => e.document.fileName === file)
    
    if (editor) {
      log(`文件在编辑器中打开，使用编辑器内容`);
      const content = editor.document.getText()
      
      // 使用 PostCSS 解析 SCSS 文件中的 BEM 类名
      if (isScssFile(file)) {
        log(`检测到 SCSS 文件，使用 PostCSS 进行 BEM 解析`);
        const bemStyles = parseScssBem(file);
        log(`BEM 解析结果: 找到 ${bemStyles.length} 个类名`);
        return { 
          file, 
          styles: bemStyles.map(style => ({
            name: style.name,
            pos: style.pos,
            doc: style.doc
          }))
        };
      }
      
      // 使用原来的方法处理非 SCSS 文件
      log(`使用传统方法解析非 SCSS 文件`);
      const parsedStyles = quickParseStyle(isScss(file) ? loadScss({ data: content, file }) : content);
      log(`传统解析结果: 找到 ${parsedStyles.length} 个类名`);
      return { file, styles: parsedStyles };
    } else {
      log(`文件未在编辑器中打开，从文件系统读取`);
      const stat = fs.statSync(file)
      if (cache && stat.mtime <= cache.mtime) {
        log(`使用缓存的解析结果，包含 ${cache.value.styles.length} 个类名`);
        return cache.value
      }
      
      // 使用 PostCSS 解析 SCSS 文件中的 BEM 类名
      if (isScssFile(file)) {
        log(`检测到 SCSS 文件，使用 PostCSS 进行 BEM 解析`);
        const bemStyles = parseScssBem(file);
        log(`BEM 解析结果: 找到 ${bemStyles.length} 个类名`);
        const value = { 
          file, 
          styles: bemStyles.map(style => ({
            name: style.name,
            pos: style.pos,
            doc: style.doc
          }))
        };
        cache = { mtime: stat.mtime, value };
        fileCache[file] = cache;
        return value;
      }
      
      // 使用原来的方法处理非 SCSS 文件
      log(`使用传统方法解析非 SCSS 文件`);
      const fileContent = fs.readFileSync(file).toString();
      const processedContent = isScss(file) ? loadScss({ file }) : fileContent;
      const parsedStyles = quickParseStyle(processedContent);
      log(`传统解析结果: 找到 ${parsedStyles.length} 个类名`);
      
      cache = {
        mtime: stat.mtime,
        value: {
          file,
          styles: parsedStyles,
        },
      }
      fileCache[file] = cache
      return cache.value
    }
  } catch (e) {
    log(`解析样式文件失败: ${file}, 错误: ${e}`);
    return {
      file,
      styles: [],
    }
  }
}

export function getClass(doc: TextDocument, config: Config) {
  log(`获取文档 ${doc.fileName} 的样式类`);
  const localClasses = getLocalClass(doc, config);
  const globalClasses = getGlobalClass(doc, config);
  log(`找到 ${localClasses.length} 个本地样式文件和 ${globalClasses.length} 个全局样式文件`);
  return [...localClasses, ...globalClasses]
}

export function getLocalClass(doc: TextDocument, config: Config) {
  const exts = config.styleExtensions || []
  log(`查找本地样式文件，扩展名: ${exts.join(', ')}`);
  
  const dir = path.dirname(doc.fileName)
  const basename = path.basename(doc.fileName, path.extname(doc.fileName))
  
  for (const ext of exts) {
    const possibleFile = path.join(dir, basename + '.' + ext);
    log(`检查可能的本地样式文件: ${possibleFile}`);
  }
  
  const localFile = exts.map(e => path.join(dir, basename + '.' + e)).find(f => fs.existsSync(f))
  
  if (localFile) {
    log(`找到本地样式文件: ${localFile}`);
    return [parseStyleFile(localFile)];
  } else {
    log(`未找到本地样式文件`);
    return [];
  }
}

export function getGlobalClass(doc: TextDocument, config: Config) {
  const root = getRoot(doc) as string
  if (!root) {
    log(`未找到工作区根目录`);
    return [];
  }
  
  log(`查找全局样式文件，工作区根目录: ${root}`);
  const files = (config.globalStyleFiles || []).map(f => path.resolve(root, f))
  log(`全局样式文件: ${files.join(', ')}`);
  
  return files.map(file => {
    log(`解析全局样式文件: ${file}`);
    return parseStyleFile(file);
  });
}
