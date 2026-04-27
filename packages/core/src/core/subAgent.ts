/**
 * @license
 * Copyright 2025 DeepV Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { PartListUnion } from '@google/genai';
import { Content } from '../types/extendedContent.js';
import { Config } from '../config/config.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { PreToolExecutionHandler } from '../tools/tools.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { GeminiClient } from './client.js';
import { GeminiChat } from './geminiChat.js';
import { ToolCallRequestInfo } from './turn.js';
import { ToolExecutionEngine, ToolExecutionContext } from './toolExecutionEngine.js';
import { SubAgentAdapter } from './subAgentAdapter.js';
// TaskStateManager 已移除，简化状态管理
import { TaskPrompts } from './taskPrompts.js';
import { SessionManager } from '../services/sessionManager.js';
import { CompressionService } from '../services/compressionService.js';
import { SceneManager, SceneType } from './sceneManager.js';
import { t } from '../utils/simpleI18n.js';
import { AgentDefinition, resolveAgentTools } from '../agents/agentDefinition.js';

export interface SubAgentExecutionContext {
  agentId: string;
  taskDescription: string;
  currentTurn: number;
  maxTurns: number;
  isRunning: boolean;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface SubAgentResult {
  success: boolean;
  summary: string;
  error?: string;
  executionLog: string[];
  filesCreated?: string[];
  commandsRun?: string[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * SubAgent - 独立的AI对话和工具执行引擎
 * 用于处理复杂任务的多轮对话和工具调用
 */
export class SubAgent {
  private context: SubAgentExecutionContext;
  private executionLog: string[] = [];
  private subAgentChat?: GeminiChat; // 子Agent专用的chat实例

  // 新架构组件
  private executionEngine: ToolExecutionEngine;
  private adapter: SubAgentAdapter;
  private toolExecutionContext: ToolExecutionContext;

  // 用于等待工具完成回调的Promise resolver
  private toolCompletionResolver?: (results: any[]) => void;

  // 待处理的工具结果，下次callGemini时一起发送
  private pendingToolResults: PartListUnion[] = [];

  // 简化：无需中央状态管理

  // Session管理
  private sessionManager: SessionManager;
  private sessionId: string;

  // 压缩服务
  private compressionService: CompressionService;

  // 🎯 AbortSignal监听器清理函数
  private abortListener: (() => void) | null = null;

  /**
   * 检查AbortSignal状态，如果已被触发则抛出错误
   */
  private checkAbortSignal(): void {
    if (this.abortSignal?.aborted) {
      throw new Error(`Task cancelled by AbortSignal`);
    }
  }

  constructor(
    private readonly config: Config,
    private readonly toolRegistry: ToolRegistry,
    private readonly geminiClient: GeminiClient,
    private readonly updateOutput?: (output: string) => void,
    private readonly abortSignal?: AbortSignal,
    private readonly externalPreToolExecutionHandler?: PreToolExecutionHandler,
    private readonly agentDefinition?: AgentDefinition,
  ) {
    this.context = {
      agentId: `subagent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      taskDescription: '',
      currentTurn: 0,
      maxTurns: 10,
      isRunning: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };

    // Initialize Session management
    this.sessionManager = new SessionManager(this.config.getProjectRoot());
    this.sessionId = this.config.getSessionId();

    // Initialize compression service
    this.compressionService = new CompressionService({
      compressionTokenThreshold: 0.8, // SubAgent 使用更高阈值，避免过早压缩
      compressionPreserveThreshold: 0.3, // 保留适中历史，确保任务连续性
      skipEnvironmentMessages: 2, // 只跳过真正的环境信息，任务描述是执行历史的一部分
    });

    // 创建子Agent执行上下文
    this.toolExecutionContext = {
      agentId: this.context.agentId,
      agentType: 'sub',
      taskDescription: this.context.taskDescription,
    };

    // 创建SubAgent适配器，传入工具完成回调处理器
    this.adapter = new SubAgentAdapter(
      updateOutput,
      (message) => this.executionLog.push(message),
      this.handleToolsComplete.bind(this), // 添加工具完成处理器
      this.toolRegistry, // 传入工具注册表
      this.externalPreToolExecutionHandler, // 传入外部预执行回调
    );

    // 创建独立的工具执行引擎
    this.executionEngine = new ToolExecutionEngine({
      toolRegistry: Promise.resolve(this.createSubAgentToolRegistry()),
      adapter: this.adapter,
      config: this.config,
      hookEventHandler: this.config.getHookSystem().getEventHandler(),
      approvalMode: this.config.getApprovalMode(),
      getPreferredEditor: () => undefined, // SubAgent通常不需要编辑器
    });
  }

  /**
   * 执行子agent任务的主循环
   */
  async executeTask(
    taskDescription: string,
    maxTurns: number = 10
  ): Promise<SubAgentResult> {
    this.context = {
      ...this.context,
      taskDescription,
      maxTurns,
      currentTurn: 0,
      isRunning: true,
    };

    // 简化：SubAgent 状态通过工具调用状态体现，无需中央注册

    this.log(`SubAgent started: ${taskDescription}`);
    this.sendStatusChange('starting', {
      taskDescription,
    });

    // 🎯 设置AbortSignal监听器 - 信号驱动清理
    if (this.abortSignal) {
      const handleAbort = () => {
        console.debug(`[SubAgent] Received AbortSignal, starting cleanup: ${this.context.agentId}`);
        this.context.isRunning = false;

        // 简化：无需清理中央状态

        this.log('SubAgent received cancellation signal, stopping execution');
        this.sendStatusChange('cancelled', {
          reason: 'abort_signal',
        });
      };

      this.abortSignal.addEventListener('abort', handleAbort);
      this.abortListener = () => {
        this.abortSignal?.removeEventListener('abort', handleAbort);
      };

      // 如果信号已经被触发，立即处理
      if (this.abortSignal.aborted) {
        handleAbort();
        throw new Error('Task was cancelled before startup');
      }
    }

    try {
      // 初始化子agent专用的chat实例
      await this.initializeSubAgentChat(taskDescription);

      this.log(`SubAgent chat instance initialized, available tools: ${this.getAvailableToolNames().length}`);

      // 主对话循环
      while (this.context.currentTurn < this.context.maxTurns && this.context.isRunning) {
        const turnResult = await this.executeConversationTurn();

        // 如果任务完成，返回结果
        if (turnResult) {
          return turnResult;
        }
      }

      // 超过最大轮数，任务未完成
      const warning = t('task.timeout.warning', { turns: this.context.currentTurn });
      const creditsNotice = t('task.timeout.credits.notice');
      const summary = `${warning}\n${creditsNotice}`;
      this.log(summary);
      this.sendStatusChange('failed', {
        reason: 'max_turns_exceeded',
        summary,
        turnsUsed: this.context.currentTurn,
      });
      return this.buildErrorResult(new Error(summary));

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(t('task.execution.failed', { error: errorMessage }));
      this.sendStatusChange('failed', {
        reason: 'execution_error',
        error: errorMessage,
        turnsUsed: this.context.currentTurn,
      });
      return this.buildErrorResult(error);
    } finally {
      this.context.isRunning = false;

      // 🎯 清理AbortSignal监听器
      if (this.abortListener) {
        this.abortListener();
        this.abortListener = null;
      }

      // 简化：无需完成中央任务

      // 清理待处理的工具结果
      this.pendingToolResults = [];

      this.log(`SubAgent execution ended (final turn: ${this.context.currentTurn})`);
    }
  }

  /**
   * 计算AI响应中的工具调用数量
   */
  private countToolCalls(response: Content): number {
    if (!response.parts) return 0;

    return response.parts.filter(part => {
      // 检查Gemini格式的functionCall
      return !!part.functionCall;
    }).length;
  }

  /**
   * 取消子agent执行
   * 🎯 现在主要依赖AbortSignal机制，这个方法用于兼容性
   */
  cancel(): void {
    this.context.isRunning = false;
    console.debug(`[SubAgent] cancel()被调用: ${this.context.agentId}`);
    // 注意：清理逻辑现在由AbortSignal监听器处理
  }

  /**
   * 构建子agent固定系统提示（不包含任务描述）
   */
  private buildSystemPrompt(): string {
    if (this.agentDefinition) {
      return this.agentDefinition.systemPrompt;
    }

    const availableTools = this.getAvailableToolNames();
    return TaskPrompts.buildSubAgentFixedSystemPrompt(availableTools, this.context.maxTurns);
  }

  /**
   * 初始化子Agent专用的chat实例
   */
  private async initializeSubAgentChat(taskDescription: string): Promise<void> {
    // 先使用 startChat 创建实例（自动处理环境信息）
    this.subAgentChat = await this.geminiClient.startChat(
      [], // 空的额外历史
      { type: 'sub', agentId: this.context.agentId, taskDescription }
    );

    // 然后修改系统指令
    (this.subAgentChat as any).generationConfig.systemInstruction = this.buildSystemPrompt();

    // 设置子agent专用的工具
    const toolDeclarations = this.getSubAgentToolDeclarations();
    if (toolDeclarations.length > 0) {
      this.subAgentChat.setTools([{ functionDeclarations: toolDeclarations }]);
    }

    // 不在初始化时添加任务描述，而是在第一轮callGemini时发送
    this.log('SubAgent chat instance initialization completed');
  }

  /**
   * 执行单轮对话 - 一轮一次AI请求
   * @returns SubAgentResult 如果任务完成，否则返回 null
   */
  private async executeConversationTurn(): Promise<SubAgentResult | null> {
    // 🎯 检查AbortSignal - 每轮开始时检查
    this.checkAbortSignal();

    this.context.currentTurn++;
    this.log(`Conversation turn ${this.context.currentTurn}/${this.context.maxTurns}`);

    // 通知 UI 当前轮次，用于显示 Turn X/Y 进度
    this.sendTurnProgress();

    // 每轮调用AI，可能携带待处理的工具结果
    const aiResponse = await this.callGemini();

    // 分析AI响应
    const responseAnalysis = this.analyzeAIResponse(aiResponse);
    this.logAIResponse(responseAnalysis);

    // 如果没有工具调用，任务完成
    if (!responseAnalysis.hasToolCalls) {
      return this.handleTaskCompletion(responseAnalysis.responseText);
    }

    // 有工具调用：执行工具并准备下轮携带结果
    await this.processAndStorePendingToolResults(aiResponse, responseAnalysis.toolCount);

    await this.tryCompressHistory();

    return null; // 继续下一轮对话，携带工具结果
  }



  /**
   * 分析AI响应
   */
  private analyzeAIResponse(aiResponse: Content): {
    responseText: string;
    hasToolCalls: boolean;
    toolCount: number;
  } {
    const responseText = this.extractTextFromResponse(aiResponse);
    const hasToolCalls = this.hasToolCalls(aiResponse);
    const toolCount = this.countToolCalls(aiResponse);

    return { responseText, hasToolCalls, toolCount };
  }

  /**
   * 记录AI响应信息
   */
  private logAIResponse(analysis: { responseText: string; hasToolCalls: boolean }): void {
    const { responseText, hasToolCalls } = analysis;
    const truncatedText = responseText.length > 100
      ? `${responseText.substring(0, 100)}...`
      : responseText;

    this.log(`AI response: ${truncatedText} (${hasToolCalls ? 'with' : 'without'} tool calls)`);
  }

  /**
   * 处理任务完成
   */
  private handleTaskCompletion(responseText: string): SubAgentResult {
    this.log('AI did not call any tools, task completed');

    const summary = responseText.trim() || 'Task completed';
    this.sendStatusChange('completing', { summary });

    return this.buildSuccessResult(summary);
  }

  /**
   * 执行工具调用并存储结果，下次callGemini时一起发送
   */
  private async processAndStorePendingToolResults(aiResponse: Content, toolCount: number): Promise<void> {
    // 🎯 工具调用前检查 - 这可能是长时间操作
    this.checkAbortSignal();

    this.log(`Starting execution of ${toolCount} tool calls`);

    // 执行工具调用
    const toolCallRequests: ToolCallRequestInfo[] = [];

    // 提取工具调用请求 - Gemini格式
    aiResponse.parts?.forEach(part => {
      if (part.functionCall && part.functionCall.name) {
        const toolName = part.functionCall.name;
        const toolArgs = part.functionCall.args || {};
        const toolId = part.functionCall.id || `${part.functionCall.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const toolCallRequest: ToolCallRequestInfo = {
          callId: toolId,
          name: toolName,
          args: toolArgs,
          isClientInitiated: false,
          prompt_id: this.context.agentId,
        };
        toolCallRequests.push(toolCallRequest);

        this.log(`📋 Tool call request: ${toolName}(${toolId})`);
      }
    });

    if (toolCallRequests.length === 0) {
      return;
    }

    try {
      // 创建Promise等待工具完成回调
      const toolCompletionPromise = new Promise<any[]>((resolve) => {
        this.toolCompletionResolver = resolve;
      });

      // 启动工具执行
      this.executionEngine.executeTools(
        toolCallRequests,
        this.toolExecutionContext,
        this.abortSignal!,
      ).catch(error => {
        this.log(`Tool execution engine error: ${error instanceof Error ? error.message : String(error)}`);
      });

      // 等待工具完成回调
      const completedCalls = await toolCompletionPromise;
      this.log(`Received ${completedCalls.length} tool call results via callback`);

      // 将工具结果转换为function responses并存储到pendingToolResults
      completedCalls.forEach((call: any) => {
        this.pendingToolResults.push(call.response?.responseParts);
      });

      // 🎯 工具调用后检查
      this.checkAbortSignal();

      this.log(`${completedCalls.length} tool calls completed, results stored in pending queue`);
    } catch (error) {
      this.log(`Tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 调用Gemini AI获取响应
   */
  private async callGemini(): Promise<Content> {
    if (!this.subAgentChat) {
      throw new Error('SubAgent chat not initialized');
    }

    // 🎯 在发送AI消息前检查取消信号
    this.checkAbortSignal();

    // 智能消息处理：第一轮发送任务描述，后续轮次合并工具结果和继续消息
    const isFirstTurn = this.context.currentTurn === 1;
    let messageParts: any[] = [];

    if (isFirstTurn) {
      // 第一轮：发送完整任务描述（带轮数预算提醒）
      messageParts = [{ text: TaskPrompts.buildSubAgentTaskPrompt(this.context.taskDescription, this.context.maxTurns) }];
    } else {
      // 后续轮次：检查是否有待处理的工具结果
      if (this.pendingToolResults.length > 0) {
        // 将待处理的工具结果添加到消息开头
        this.pendingToolResults.forEach(result => {
          if (Array.isArray(result)) {
            messageParts.push(...result);
          } else {
            messageParts.push(result);
          }
        });
        this.pendingToolResults = [];
      }
    }

    // 📝 保存请求日志
    const timestamp = new Date().toISOString();
    const currentHistory = this.subAgentChat.getHistory();
    const logData = {
      timestamp,
      turn: this.context.currentTurn,
      request: {
        history: currentHistory,
        messageParts
      }
    };

    // 保存请求部分到日志
    await this.sessionManager.saveRequestLog(this.sessionId, logData).catch(error => {
      console.warn('[SubAgent] Failed to save request log:', error);
    });

    // 发送消息给AI
    const response = await this.subAgentChat.sendMessage({
      message: messageParts,
      config: {
        abortSignal: this.abortSignal
      }
    }, this.context.agentId, SceneType.SUB_AGENT);

    // 更新token使用统计
    const tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };

    if (response?.usageMetadata) {
      tokenUsage.inputTokens = response.usageMetadata.promptTokenCount || 0;
      tokenUsage.outputTokens = response.usageMetadata.candidatesTokenCount || 0;
      tokenUsage.totalTokens = response.usageMetadata.totalTokenCount || 0;

      this.context.tokenUsage.inputTokens += tokenUsage.inputTokens;
      this.context.tokenUsage.outputTokens += tokenUsage.outputTokens;
      this.context.tokenUsage.totalTokens += tokenUsage.totalTokens;
    }

    // 提取AI的响应内容
    const aiContent: Content = {
      role: MESSAGE_ROLES.MODEL,
      parts: response.candidates?.[0]?.content?.parts || []
    };

    // 📝 保存完整日志（包含响应）
    const fullLogData = {
      ...logData,
      response: {
        content: aiContent,
        tokenUsage
      }
    };

    // 覆盖保存完整日志
    await this.sessionManager.saveRequestLog(this.sessionId, fullLogData).catch(error => {
      console.warn('[SubAgent] Failed to save response log:', error);
    });

    return aiContent;
  }

  /**
   * 检查响应中是否包含工具调用 - Gemini格式
   */
  private hasToolCalls(response: Content): boolean {
    return response.parts?.some(part => !!part.functionCall) || false;
  }

  /**
   * 处理工具完成回调
   */
  private handleToolsComplete(completedCalls: any[]): void {
    if (this.toolCompletionResolver) {
      this.toolCompletionResolver(completedCalls);
      this.toolCompletionResolver = undefined;
    }
  }

  /**
   * 获取SubAgentAdapter的执行统计
   */
  private getExecutionStats(): {
    filesCreated: string[];
    commandsRun: string[];
    executionLog: string[];
  } {
    return {
      filesCreated: this.adapter.getFilesCreated(),
      commandsRun: this.adapter.getCommandsRun(),
      executionLog: this.executionLog,
    };
  }

  /**
   * 从AI响应中提取文本 - Gemini格式
   */
  private extractTextFromResponse(response: Content): string {
    return (response.parts || [])
      .map(part => part.text || '')
      .filter(text => text.trim().length > 0)
      .join('\n');
  }

  /**
   * 创建子agent专用的工具注册表
   */
  private createSubAgentToolRegistry(): ToolRegistry {
    const subAgentRegistry = new ToolRegistry(this.config);

    const allTools = this.toolRegistry.getAllTools();
    const resolvedTools = this.agentDefinition
      ? resolveAgentTools(this.agentDefinition, allTools).resolvedTools
      : allTools.filter(tool => tool.allowSubAgentUse);

    resolvedTools.forEach(tool => {
      subAgentRegistry.registerTool(tool);
    });

    return subAgentRegistry;
  }

  /**
   * 获取子agent可用的工具名称
   */
  private getAvailableToolNames(): string[] {
    return this.createSubAgentToolRegistry()
      .getAllTools()
      .map(tool => tool.name);
  }

  /**
   * 获取子agent的工具声明
   */
  private getSubAgentToolDeclarations() {
    return this.createSubAgentToolRegistry().getFunctionDeclarations();
  }

  /**
   * 构建成功结果
   */
  private buildSuccessResult(summary: string): SubAgentResult {
    const stats = this.getExecutionStats();
    return {
      success: true,
      summary,
      executionLog: stats.executionLog,
      filesCreated: stats.filesCreated,
      commandsRun: stats.commandsRun,
      tokenUsage: this.context.tokenUsage,
    };
  }

  /**
   * 构建错误结果
   */
  private buildErrorResult(error: unknown): SubAgentResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.log(`❌ Execution error: ${errorMessage}`);

    const stats = this.getExecutionStats();
    return {
      success: false,
      summary: `Task execution failed: ${errorMessage}`,
      error: errorMessage,
      executionLog: stats.executionLog,
      filesCreated: stats.filesCreated,
      commandsRun: stats.commandsRun,
      tokenUsage: this.context.tokenUsage,
    };
  }

  /**
   * 发送当前轮次进度通知，用于 UI 显示 Turn X/Y
   */
  private sendTurnProgress(): void {
    const event = {
      type: 'conversation_turn',
      agentId: this.context.agentId,
      turnNumber: this.context.currentTurn,
      maxTurns: this.context.maxTurns,
      timestamp: Date.now(),
    };
    this.updateOutput?.(`SUBAGENT_EVENT:${JSON.stringify(event)}`);
  }

  /**
   * 发送状态变化通知
   */
  private sendStatusChange(status: string, details?: any): void {
    const statusEvent = {
      type: 'status_change',
      agentId: this.context.agentId,
      status,
      currentTurn: this.context.currentTurn,
      maxTurns: this.context.maxTurns,
      taskDescription: this.context.taskDescription,
      timestamp: Date.now(),
      ...details,
    };

    const structuredUpdate = `SUBAGENT_STATUS_CHANGE:${JSON.stringify(statusEvent)}`;
    this.updateOutput?.(structuredUpdate);
  }

  /**
   * Log method with timestamp prefix
   */
  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const formattedMessage = `[${timestamp}] ${message}`;
    this.executionLog.push(formattedMessage);
    console.log('[SubAgent] ' + formattedMessage);
  }

  /**
   * 尝试压缩对话历史
   */
  private async tryCompressHistory(): Promise<void> {
    if (!this.subAgentChat) {
      return;
    }

    try {
      const currentHistory = this.subAgentChat.getHistory(true); // 使用精选历史进行压缩
      const compressionModel = SceneManager.getModelForScene(SceneType.COMPRESSION);
      const historyModel = this.config.getModel(); // subAgent历史使用的模型，用于测算长度

      // 使用压缩服务检查并执行压缩
      const compressionResult = await this.compressionService.tryCompress(
        this.config,
        currentHistory,
        historyModel!,
        compressionModel!,
        this.geminiClient, // 传递 GeminiClient 实例而不是 ContentGenerator
        this.context.agentId,
        this.abortSignal!
      );

      if (compressionResult && compressionResult.success && compressionResult.newHistory) {
        // 应用压缩结果：直接设置新的历史记录
        this.subAgentChat.setHistory(compressionResult.newHistory);

        this.log(`📦 Conversation history compressed: ${compressionResult.compressionInfo?.originalTokenCount} -> ${compressionResult.compressionInfo?.newTokenCount} tokens`);
      }
    } catch (error) {
      // 压缩失败不应该影响正常执行
      this.log(`⚠️ Conversation history compression failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 获取适配器实例
   */
  getAdapter(): SubAgentAdapter {
    return this.adapter;
  }
}
