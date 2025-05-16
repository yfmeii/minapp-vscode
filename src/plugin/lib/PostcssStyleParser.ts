import * as postcss from 'postcss';
import * as postcssScss from 'postcss-scss';
import * as fs from 'fs';
import { Position, window, OutputChannel } from 'vscode';
import { getFileContent } from './helper';

// 创建输出通道用于日志记录
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

export interface BemStyle {
  name: string;       // 完整的类名（不包含前导点）
  pos: Position;      // 在源文件中的位置
  doc: string;        // 文档注释
  source: {
    file: string;     // 源文件路径
    selector: string; // 原始选择器
  };
  // 添加选择器范围信息
  selectorRange?: {
    start: Position;  // 选择器开始位置
    end: Position;    // 选择器结束位置
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
 * 判断样式文件类型
 */
export function getStyleFileType(file: string): 'scss' | 'css' | 'less' | 'wxss' | 'unknown' {
  if (/\.s[ac]ss$/.test(file)) return 'scss';
  if (/\.css$/.test(file)) return 'css';
  if (/\.less$/.test(file)) return 'less';
  if (/\.wxss$/.test(file)) return 'wxss';
  return 'unknown';
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
  comments: { [line: number]: string },
  content: string,
  processedClassNames: Set<string> = new Set<string>()
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
    const endPosition = source?.end;
    
    // 提取所有类名并保存
    if (startPosition && endPosition) {
      const position = new Position(startPosition.line - 1, startPosition.column - 1);
      log(`规则在文件中的位置: 行=${position.line}, 列=${position.character}`);
      
      // 获取选择器声明的精确范围，避免包含伪元素和嵌套规则
      let selectorRange = getSelectorDeclarationRange(rule, content);
      
      if (!selectorRange) {
        log(`无法确定选择器声明范围，将使用默认范围`);
        // 使用默认范围（整个规则块）
        selectorRange = {
          start: new Position(startPosition.line - 1, startPosition.column - 1),
          end: new Position(endPosition.line - 1, endPosition.column - 1)
        };
      } else {
        log(`使用精确的选择器声明范围: 从 (${selectorRange.start.line}, ${selectorRange.start.character}) 到 (${selectorRange.end.line}, ${selectorRange.end.character})`);
      }
      
      // 提取当前选择器中定义的类名
      for (const normalizedSelector of normalizedSelectors) {
        // 过滤掉包含伪元素的选择器（如 ::after）
        if (normalizedSelector.includes('::') || normalizedSelector.includes(':before') || normalizedSelector.includes(':after')) {
          log(`跳过伪元素选择器: ${normalizedSelector}`);
          continue;
        }
        
        const classNames = extractClassNames(normalizedSelector);
        
        // 获取当前规则的注释
        const lineNumber = startPosition.line;
        const commentText = comments[lineNumber - 1] || comments[lineNumber - 2] || '';
        
        log(`选择器 '${normalizedSelector}' 的注释: '${commentText}'`);
        
        for (const className of classNames) {
          const name = className.substring(1); // 移除前导点
          
          // 检查该类名是否已经处理过，如果是则跳过
          if (processedClassNames.has(name)) {
            log(`跳过已处理过的类名: ${name}`);
            continue;
          }
          
          // 将类名添加到已处理集合中
          processedClassNames.add(name);
          log(`添加类名 ${name} 到已处理集合`);
          
          styles.push({
            name,
            pos: position,
            doc: commentText,
            source: {
              file: filePath,
              selector: normalizedSelector
            },
            selectorRange: selectorRange
          });
          log(`添加类名: '${name}', 位置: 行=${position.line}, 列=${position.character}, 选择器范围: ${selectorRange.start.line}:${selectorRange.start.character} - ${selectorRange.end.line}:${selectorRange.end.character}`);
        }
      }
    }
    
    // 如果规则有子节点，递归处理
    if (rule.nodes && rule.nodes.length > 0) {
      log(`递归处理嵌套规则，父选择器: ${JSON.stringify(normalizedSelectors)}`);
      walkRules(rule, normalizedSelectors, styles, filePath, comments, content, processedClassNames);
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
 * 获取选择器声明的精确范围（从选择器开始到第一个大括号）
 * 避免选中整个嵌套规则块，尤其是包含伪元素的情况
 */
function getSelectorDeclarationRange(
  rule: postcss.Rule,
  content: string
): { start: Position, end: Position } | undefined {
  const source = rule.source;
  const startPosition = source?.start;
  const endPosition = source?.end;
  
  if (!startPosition || !endPosition) {
    return undefined;
  }
  
  // 选择器开始位置
  const start = new Position(startPosition.line - 1, startPosition.column - 1);
  
  // 默认结束位置（作为备用）
  let end = new Position(endPosition.line - 1, endPosition.column - 1);
  
  try {
    // 获取规则在原始文本中的位置
    const ruleText = rule.toString();
    // 计算规则在原始文本中的偏移量
    const ruleStartOffset = content.indexOf(ruleText, startPosition.offset || 0);
    
    if (ruleStartOffset !== -1) {
      // 找到第一个大括号的位置
      const openBraceOffset = content.indexOf('{', ruleStartOffset);
      
      if (openBraceOffset !== -1) {
        // 计算大括号在整个文本中的行列位置
        const beforeBrace = content.substring(0, openBraceOffset);
        const lineBreaks = beforeBrace.match(/\n/g) || [];
        const braceLineNumber = lineBreaks.length;
        
        // 找到大括号所在行的开始位置
        const lastLineBreakOffset = beforeBrace.lastIndexOf('\n');
        const braceColumnNumber = lastLineBreakOffset === -1 
          ? openBraceOffset 
          : openBraceOffset - lastLineBreakOffset - 1;
        
        // 设置选择器声明的结束位置（大括号的位置）
        end = new Position(braceLineNumber, braceColumnNumber);
        
        log(`计算选择器声明范围: 从 (${start.line}, ${start.character}) 到 (${end.line}, ${end.character})`);
      }
    }
  } catch (error) {
    log(`计算选择器声明范围失败: ${error}`);
  }
  
  return { start, end };
}

/**
 * 通用的样式文件解析函数，使用PostCSS处理各种样式文件
 */
export function parseStyleWithPostcss(filePath: string): BemStyle[] {
  log(`开始使用PostCSS解析样式文件: ${filePath}`);
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
    
    // 根据文件类型选择不同的解析器
    const fileType = getStyleFileType(filePath);
    log(`文件类型: ${fileType}`);
    
    // 创建PostCSS处理器
    const processor = postcss();
    
    // 根据文件类型选择解析器
    let result;
    if (fileType === 'scss') {
      result = processor.process(content, { 
        from: filePath,
        parser: postcssScss as any
      });
    } else {
      // 默认使用标准CSS解析器
      result = processor.process(content, { 
        from: filePath
      });
    }
    
    const styles: BemStyle[] = [];
    
    // 初始化已处理的类名集合
    const processedClassNames = new Set<string>();
    
    // 开始解析
    log(`开始遍历规则树`);
    walkRules(result.root, [], styles, filePath, comments, content, processedClassNames);
    
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
    log(`解析样式文件失败: ${filePath}, 错误: ${error}`);
    console.error(`解析样式文件失败: ${filePath}`, error);
    return [];
  }
}

/**
 * 解析 SCSS 文件，提取所有 BEM 风格的类名（保留兼容性）
 */
export function parseScssBem(filePath: string): BemStyle[] {
  return parseStyleWithPostcss(filePath);
} 