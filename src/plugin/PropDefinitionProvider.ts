import { Config } from './lib/config'
import { DefinitionProvider, TextDocument, Position, CancellationToken, Location, Uri, Range, window, OutputChannel } from 'vscode'
import { getTagAtPosition } from './getTagAtPosition'
import { getClass } from './lib/StyleFile'
import { getProp } from './lib/ScriptFile'
import { definitionTagName } from '../common/src'
import { getCustomOptions, getLanguage } from './lib/helper'

// 获取或创建输出通道
let outputChannel: OutputChannel | null = null;
function getOutputChannel(): OutputChannel {
  if (!outputChannel) {
    outputChannel = window.createOutputChannel('Minapp Definition Debug');
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

const reserveWords = ['true', 'false']

export class PropDefinitionProvider implements DefinitionProvider {
  constructor(public config: Config) {}
  public async provideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Location[]> {
    const tag = getTagAtPosition(document, position)
    const locs: Location[] = []

    log(`提供定义: 文件=${document.fileName}, 位置=行${position.line}列${position.character}`);
    
    if (tag) {
      log(`找到标签: ${JSON.stringify({
        name: tag.name,
        isOnTagName: tag.isOnTagName,
        isOnAttrName: tag.isOnAttrName,
        isOnAttrValue: tag.isOnAttrValue,
        attrName: tag.attrName,
        posWord: tag.posWord
      })}`);
      
      const language = getLanguage(document, position);
      if (tag.isOnTagName) {
        if (language) {
          log(`在标签名上: ${tag.name}, 语言=${language.id}`);
          const component = await definitionTagName(tag.name, language, getCustomOptions(this.config, document));
          if (component && component.path) {
            log(`找到组件定义: ${component.path}`);
            locs.push(new Location(Uri.file(component.path), new Position(0, 0)))
          }
        }
        return locs;
      }
      const { attrs, attrName, posWord } = tag
      const rawAttrValue = ((attrs['__' + attrName] || '') as string).replace(/^['"]|['"]$/g, '') // 去除引号
      log(`属性名: ${attrName}, 位置单词: ${posWord}, 原始属性值: ${rawAttrValue}`);

      // 处理在属性名上的点击，特别是 bind 或 catch 开头的属性
      if (tag.isOnAttrName) {
        log(`在属性名上: ${posWord}`);
        // 如果是点击在 bindxxx 或 catchxxx 等事件处理属性上
        if (/^(mut-bind|capture-catch|capture-bind|bind|catch)/.test(posWord) || /\.(user|stop|default)$/.test(posWord)) {
          log(`检测到事件处理属性: ${posWord}`);
          // 找到属性值作为方法名
          const methodName = attrs[posWord]
          if (methodName && typeof methodName === 'string') {
            // 去除引号
            const cleanMethodName = methodName.replace(/^['"]|['"]$/g, '')
            log(`搜索方法: ${cleanMethodName}`);
            return this.searchScript('method', cleanMethodName, document)
          }
        }
        return locs
      }

      // 不在属性值上
      if (!tag.isOnAttrValue) return locs

      // 忽略特殊字符或者以数字开头的单词
      if (reserveWords.includes(posWord) || /^\d/.test(posWord)) {
        log(`忽略保留字或数字: ${posWord}`);
        return locs;
      }

      if (attrName.endsWith('class')) {
        log(`搜索样式类名: ${posWord}`);
        return this.searchStyle(posWord, document, position)
      } else if (attrName.endsWith('.sync') || (rawAttrValue.startsWith('{{') && rawAttrValue.endsWith('}}'))) {
        log(`搜索属性: ${posWord}`);
        return this.searchScript('prop', posWord, document)
      } else if (/^(mut-bind|capture-catch|capture-bind|bind|catch)/.test(attrName) || /\.(user|stop|default)$/.test(attrName)) {
        log(`搜索方法: ${posWord}`);
        return this.searchScript('method', posWord, document)
      } else if (document.getWordRangeAtPosition(position, /\{\{[\s\w]+\}\}/)) {
        /**
         * fix case like:
         * ```wxml
         * style="height: {{bottom}}rpx"
         * ```
         */
        log(`搜索插值表达式中的方法: ${posWord}`);
        return this.searchScript('method', posWord, document)
      }
    } else {
      // 判断是否是在 {{ }} 中
      const range = document.getWordRangeAtPosition(position, /\{\{[\s\w]+\}\}/)
      if (!range) return locs
      const text = document.getText(range).replace(/^\{\{\s*|\s*\}\}$/g, '')
      log(`在插值表达式中: ${text}`);
      return this.searchScript('prop', text, document)
    }
    return locs
  }

  searchScript(type: 'prop' | 'method', word: string, doc: TextDocument): Location[] {
    log(`在脚本中搜索 ${type}: ${word}`);
    const locations = getProp(doc.fileName, type, word).map(p => p.loc);
    log(`找到 ${locations.length} 个结果`);
    return locations;
  }

  searchStyle(className: string, document: TextDocument, position: Position): Location[] {
    log(`搜索样式类名: ${className}`);
    const exactMatchLocs: Location[] = [] // 存储完全匹配的位置
    const bemMatchLocs: Location[] = [] // 存储 BEM 匹配的位置

    const styleFiles = getClass(document, this.config);
    log(`找到 ${styleFiles.length} 个样式文件`);
    
    styleFiles.forEach(styfile => {
      log(`检查样式文件: ${styfile.file}, 包含 ${styfile.styles.length} 个类名`);
      
      styfile.styles.forEach(sty => {
        // 检查完全匹配
        if (sty.name === className) {
          log(`找到完全匹配的类名: ${sty.name} 在 ${styfile.file} 的位置行=${sty.pos.line}, 列=${sty.pos.character}`);
          
          // 使用PostCSS解析出的选择器范围信息
          if (sty.selectorRange) {
            log(`使用选择器范围信息: 从行 ${sty.selectorRange.start.line} 到行 ${sty.selectorRange.end.line}`);
            exactMatchLocs.push(new Location(Uri.file(styfile.file), new Range(sty.selectorRange.start, sty.selectorRange.end)));
          } else {
            // 如果没有选择器范围信息（向后兼容），只选中类名
            log(`没有选择器范围信息，只选中类名`);
            const end = new Position(sty.pos.line, sty.pos.character + className.length);
            exactMatchLocs.push(new Location(Uri.file(styfile.file), new Range(sty.pos, end)));
          }
          return;
        }
        
        // 支持 BEM 风格嵌套类名
        // 检查嵌套的类名是否匹配 BEM 模式，例如 className 是 "block__element--modifier"
        // 我们将检查 "block__element" 和 "block" 是否存在
        if (className.includes('__') || className.includes('--')) {
          // 处理 BEM 格式
          const bemParts = className.split(/__|--/);
          let bemClass = bemParts[0]; // 基础类名
          log(`处理 BEM 类名: ${className}, 基础类名: ${bemClass}, 当前比较: ${sty.name}`);
          
          // 如果当前类名是 BEM 基础类名或 BEM 链的一部分
          if (sty.name === bemClass || className.startsWith(sty.name + '__') || className.startsWith(sty.name + '--')) {
            log(`找到 BEM 匹配: 搜索的 "${className}" 与样式 "${sty.name}" 匹配，在 ${styfile.file} 的位置行=${sty.pos.line}, 列=${sty.pos.character}`);
            
            // 使用PostCSS解析出的选择器范围信息
            if (sty.selectorRange) {
              log(`使用 BEM 选择器范围信息: 从行 ${sty.selectorRange.start.line} 到行 ${sty.selectorRange.end.line}`);
              bemMatchLocs.push(new Location(Uri.file(styfile.file), new Range(sty.selectorRange.start, sty.selectorRange.end)));
            } else {
              // 如果没有选择器范围信息（向后兼容），只选中类名
              log(`没有 BEM 选择器范围信息，只选中类名`);
              const end = new Position(sty.pos.line, sty.pos.character + sty.name.length);
              bemMatchLocs.push(new Location(Uri.file(styfile.file), new Range(sty.pos, end)));
            }
          }
        }
      });
    });

    // 优先返回完全匹配的结果，如果没有才返回 BEM 匹配的结果
    if (exactMatchLocs.length > 0) {
      log(`返回 ${exactMatchLocs.length} 个完全匹配的位置`);
      return exactMatchLocs;
    }
    
    // 没有完全匹配，返回 BEM 匹配的结果
    log(`返回 ${bemMatchLocs.length} 个 BEM 匹配的位置`);
    return bemMatchLocs;
  }
}
