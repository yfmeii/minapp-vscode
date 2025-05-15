import * as postcss from 'postcss';
import * as postcssScss from 'postcss-scss';
import * as fs from 'fs';
import { Position, window, OutputChannel } from 'vscode';
import { getFileContent } from './helper';

// 创建输出通道用于日志记录
let outputChannel: OutputChannel | null = null;

function getOutputChannel(): OutputChannel {
  if (!outputChannel) {
    outputChannel = window.createOutputChannel('Minapp BEM Debug');
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

export interface BemStyle {
  name: string;       // 完整的类名（不包含前导点）
  pos: Position;      // 在源文件中的位置
  doc: string;        // 文档注释
  source: {
    file: string;     // 源文件路径
    selector: string; // 原始选择器
  };
}

// 缓存系统，避免重复解析
const fileCache: { [file: string]: { mtime: Date; styles: BemStyle[] } } = {};

/**
 * 判断是否为 SCSS 文件
 */
export function isScssFile(file: string): boolean {
  const result = /\.s[ac]ss$/.test(file);
  log(`检查文件 ${file} 是否为SCSS文件: ${result}`);
  return result;
}

/**
 * 从选择器中提取类名
 */
function extractClassNames(selector: string): string[] {
  // 匹配所有 .classname 格式的选择器
  const matches = selector.match(/\.[a-zA-Z][\w-_]*/g) || [];
  const classNames = matches.map(className => className.trim());
  log(`从选择器 '${selector}' 提取类名: ${JSON.stringify(classNames)}`);
  return classNames;
}

/**
 * 规范化选择器，处理&符号
 */
function normalizeSelector(selector: string, parentSelectors: string[]): string[] {
  // 移除空格和换行
  selector = selector.trim().replace(/\s+/g, ' ');
  
  log(`规范化选择器: '${selector}', 父选择器: ${JSON.stringify(parentSelectors)}`);
  
  // 如果没有父选择器，直接返回当前选择器
  if (parentSelectors.length === 0 || !selector.includes('&')) {
    log(`没有父选择器或不包含&符号，返回原选择器: '${selector}'`);
    return [selector];
  }
  
  // 处理多个父选择器的情况（如 .a, .b { &__c {} }）
  const result: string[] = [];
  
  for (const parentSelector of parentSelectors) {
    // 替换 & 符号
    const normalized = selector.replace(/&/g, parentSelector);
    result.push(normalized);
    log(`将 '${selector}' 中的 & 替换为 '${parentSelector}', 结果: '${normalized}'`);
  }
  
  log(`规范化结果: ${JSON.stringify(result)}`);
  return result;
}

/**
 * 递归遍历规则，构建完整的选择器
 */
function walkRules(
  node: postcss.Container, 
  parentSelectors: string[], 
  styles: BemStyle[],
  filePath: string,
  comments: { [line: number]: string }
): void {
  log(`开始遍历规则，当前父选择器: ${JSON.stringify(parentSelectors)}`);
  
  node.walkRules(rule => {
    const selectors = rule.selectors || [rule.selector];
    log(`处理规则: ${JSON.stringify(selectors)}`);
    
    // 处理所有选择器（处理逗号分隔的多选择器）
    let normalizedSelectors: string[] = [];
    
    for (const selector of selectors) {
      // 规范化当前选择器，考虑所有父选择器
      const normalized = normalizeSelector(selector, parentSelectors.length ? parentSelectors : []);
      normalizedSelectors = normalizedSelectors.concat(normalized);
    }
    
    log(`规范化后的选择器: ${JSON.stringify(normalizedSelectors)}`);
    
    // 保存当前规则的位置，用于生成位置信息
    const source = rule.source;
    const startPosition = source?.start;
    
    // 提取所有类名并保存
    if (startPosition) {
      const position = new Position(startPosition.line - 1, startPosition.column - 1);
      log(`规则在文件中的位置: 行=${position.line}, 列=${position.character}`);
      
      // 提取当前选择器中定义的类名
      for (const normalizedSelector of normalizedSelectors) {
        const classNames = extractClassNames(normalizedSelector);
        
        // 获取当前规则的注释
        const lineNumber = startPosition.line;
        const commentText = comments[lineNumber - 1] || comments[lineNumber - 2] || '';
        
        log(`选择器 '${normalizedSelector}' 的注释: '${commentText}'`);
        
        for (const className of classNames) {
          const name = className.substring(1); // 移除前导点
          styles.push({
            name,
            pos: position,
            doc: commentText,
            source: {
              file: filePath,
              selector: normalizedSelector
            }
          });
          log(`添加类名: '${name}', 位置: 行=${position.line}, 列=${position.character}`);
        }
      }
    }
    
    // 如果规则有子节点，递归处理
    if (rule.nodes && rule.nodes.length > 0) {
      log(`递归处理嵌套规则，父选择器: ${JSON.stringify(normalizedSelectors)}`);
      walkRules(rule, normalizedSelectors, styles, filePath, comments);
    }
  });
}

/**
 * 提取文件中的注释
 */
function extractComments(content: string): { [line: number]: string } {
  log(`开始提取文件中的注释`);
  const comments: { [line: number]: string } = {};
  
  // 多行注释 /* ... */
  const multiLineRegex = /\/\*([\s\S]*?)\*\//g;
  let match;
  
  while ((match = multiLineRegex.exec(content)) !== null) {
    const commentText = match[1].trim();
    const beforeComment = content.substring(0, match.index);
    const lineNumber = (beforeComment.match(/\n/g) || []).length + 1;
    comments[lineNumber] = commentText;
    log(`在第 ${lineNumber} 行找到注释: '${commentText}'`);
  }
  
  log(`共提取了 ${Object.keys(comments).length} 条注释`);
  return comments;
}

/**
 * 解析 SCSS 文件，提取所有 BEM 风格的类名
 */
export function parseScssBem(filePath: string): BemStyle[] {
  log(`开始解析SCSS文件: ${filePath}`);
  try {
    // 检查缓存
    const stats = fs.statSync(filePath);
    const cachedData = fileCache[filePath];
    
    if (cachedData && cachedData.mtime.getTime() === stats.mtime.getTime()) {
      log(`使用缓存的解析结果，共 ${cachedData.styles.length} 个类名`);
      return cachedData.styles;
    }
    
    // 获取文件内容
    const content = getFileContent(filePath);
    log(`文件内容长度: ${content.length} 字符`);
    
    // 提取注释
    const comments = extractComments(content);
    
    // 使用 PostCSS 解析 SCSS
    log(`使用 PostCSS 解析 SCSS 内容`);
    const processor = postcss();
    const result = processor.process(content, { 
      from: filePath,
      parser: postcssScss as any
    });
    
    const styles: BemStyle[] = [];
    
    // 开始解析
    log(`开始遍历规则树`);
    walkRules(result.root, [], styles, filePath, comments);
    
    // 更新缓存
    fileCache[filePath] = {
      mtime: stats.mtime,
      styles
    };
    
    log(`成功解析文件，共找到 ${styles.length} 个类名定义`);
    // 打印前10个类名，便于调试
    if (styles.length > 0) {
      log(`类名示例: ${styles.slice(0, 10).map(s => s.name).join(', ')}`);
    }
    
    return styles;
  } catch (error) {
    log(`解析 SCSS 文件失败: ${filePath}, 错误: ${error}`);
    console.error(`解析 SCSS 文件失败: ${filePath}`, error);
    return [];
  }
} 