import * as fs from 'fs'
import * as path from 'path'
import { TextDocument, window, Position, OutputChannel } from 'vscode'
import { Config } from './config'
import { getRoot } from './helper'
import { parseStyleWithPostcss } from './PostcssStyleParser'

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

// 扩展Style接口，与BemStyle保持一致
export interface Style {
  name: string
  pos: Position
  doc: string
  // 添加选择器范围信息
  selectorRange?: {
    start: Position;  // 选择器开始位置
    end: Position;    // 选择器结束位置
  };
}

export interface StyleFile {
  file: string
  styles: Style[]
}

const fileCache: { [file: string]: { mtime: Date; value: StyleFile } } = {}

export function parseStyleFile(file: string) {
  log(`解析样式文件: ${file}`);
  try {
    let cache = fileCache[file]
    const editor = window.visibleTextEditors.find(e => e.document.fileName === file)
    
    if (editor) {
      log(`文件在编辑器中打开，使用编辑器内容`);
      // 直接使用PostCSS解析，不再区分SCSS和其他文件类型
      log(`使用PostCSS解析样式文件`);
      const styles = parseStyleWithPostcss(file);
      log(`PostCSS解析结果: 找到 ${styles.length} 个类名`);
      return { 
        file, 
        styles: styles.map(style => ({
          name: style.name,
          pos: style.pos,
          doc: style.doc,
          selectorRange: style.selectorRange
        }))
      };
    } else {
      log(`文件未在编辑器中打开，从文件系统读取`);
      const stat = fs.statSync(file)
      if (cache && stat.mtime <= cache.mtime) {
        log(`使用缓存的解析结果，包含 ${cache.value.styles.length} 个类名`);
        return cache.value
      }
      
      // 直接使用PostCSS解析，不再区分SCSS和其他文件类型
      log(`使用PostCSS解析样式文件`);
      const styles = parseStyleWithPostcss(file);
      log(`PostCSS解析结果: 找到 ${styles.length} 个类名`);
      
      const value = { 
        file, 
        styles: styles.map(style => ({
          name: style.name,
          pos: style.pos,
          doc: style.doc,
          selectorRange: style.selectorRange
        }))
      };
      
      cache = { mtime: stat.mtime, value };
      fileCache[file] = cache;
      return value;
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
