/**
 * Chat Interface Component
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Loader2, ArrowDown, AlertTriangle } from 'lucide-react';
import { ChatMessage, ToolCall, MessageContent, MessageQueueItem } from '../types';
import { ModifiedFile } from '../types/fileChanges';
import { extractModifiedFiles } from '../utils/fileChangeExtractor';
import { MessageBubble } from './MessageBubble';
import { MessageQueueList } from './MessageQueueList';
import { ToolCallList } from './ToolCallList';
import { StickyTodoPanel } from './StickyTodoPanel';
import { MessageInput } from './MessageInput';
import FilesChangedBar from './FilesChangedBar';
import BackgroundTasksBar from './BackgroundTasksBar';
import { useTranslation } from '../hooks/useTranslation';
import { useBackgroundTasks } from '../hooks/useBackgroundTasks';
import './ChatInterface.css';
import { getGlobalMessageService } from '../services/globalMessageService';
import { createTextMessageContent } from '../utils/messageContentUtils';

interface ChatInterfaceProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSendMessage: (content: MessageContent) => void;
  onToolConfirm?: (toolCallId: string, confirmed: boolean, userInput?: string) => void;
  // 🎯 新增：流程控制
  isProcessing?: boolean;        // 是否正在处理
  canAbort?: boolean;           // 是否可以中断
  onAbortProcess?: () => void;  // 中断处理回调
  // 🎯 新增：文件变更跟踪
  lastAcceptedMessageId?: string | null;
  onSetLastAcceptedMessageId?: (messageId: string) => void;
  // 🎯 新增：模型选择
  selectedModelId?: string;
  onModelChange?: (modelId: string) => void;
  // 🎯 新增：会话管理
  sessionId?: string;           // 当前会话ID
  // 🎯 新增：消息列表更新
  onUpdateMessages?: (messages: ChatMessage[]) => void;  // 更新消息列表回调
  // 🎯 新增：可回滚消息ID列表
  rollbackableMessageIds?: string[];  // 可以回滚编辑的消息ID列表
  // 🎯 新增：Token使用情况
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    tokenLimit: number;
    cachedContentTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    creditsUsage?: number;
  };
  // 🎯 新增：MessageInput ref（用于插入代码引用）
  messageInputRef?: React.RefObject<any>;
  // 🎯 新增：Plan模式
  isPlanMode?: boolean;         // 是否在Plan模式
  onTogglePlanMode?: (enabled: boolean) => void;  // Plan模式切换回调
  // 🎯 新增：消息队列
  messageQueue?: MessageQueueItem[];
  onAddMessageToQueue?: (content: MessageContent) => void;
  onRemoveMessageFromQueue?: (id: string) => void;
  onUpdateMessageQueue?: (newQueue: MessageQueueItem[]) => void;
  // 🎯 新增：模型切换状态
  isModelSwitching?: boolean;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  messages,
  isLoading,
  onSendMessage,
  onToolConfirm,
  isProcessing = false,
  canAbort = false,
  onAbortProcess,
  lastAcceptedMessageId: propLastAcceptedMessageId,
  onSetLastAcceptedMessageId,
  selectedModelId,
  onModelChange,
  sessionId,
  onUpdateMessages,
  tokenUsage,
  rollbackableMessageIds = [],
  messageInputRef,
  isPlanMode = false,
  onTogglePlanMode,
  messageQueue = [],
  onAddMessageToQueue,
  onRemoveMessageFromQueue,
  onUpdateMessageQueue,
  isModelSwitching = false
}) => {
  const { t } = useTranslation();
  const { tasks: backgroundTasks, runningCount: backgroundRunningCount, killTask: killBackgroundTask } = useBackgroundTasks();
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isTasksBarDismissed, setIsTasksBarDismissed] = useState(false);
  // 🎯 使用 Ref 替代 State 来追踪自动滚动状态，避免 React 状态更新的延迟导致的"对抗"问题
  // 默认为 true，表示初始状态下允许自动滚动
  const shouldAutoScrollRef = useRef(true);
  const [modifiedFiles, setModifiedFiles] = useState<Map<string, ModifiedFile>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // 🎯 Todo 面板可见性和折叠状态管理
  const [isTodoCollapsed, setIsTodoCollapsed] = useState(false);
  const [isTodoVisible, setIsTodoVisible] = useState(false);

  // 🎯 当有新的 running 任务时，重新显示任务栏
  useEffect(() => {
    if (backgroundRunningCount > 0) {
      setIsTasksBarDismissed(false);
    }
  }, [backgroundRunningCount]);
  const prevProcessingRef = useRef(false);
  const turnStartTodoSignatureRef = useRef<string>(""); // 🎯 记录回合开始时的 Todo 状态签名

  // 🎯 新增：专门用于监听滚动的 Ref，绑定到 .messages-scroll-area
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  // 🎯 新增：记录最后一次点击"回到底部"的时间，用于实现"磁吸"效果
  const lastScrollClickTimeRef = useRef<number>(0);
  // 🎯 新增：记录上一次的 scrollTop，用于判断滚动方向
  const lastScrollTopRef = useRef<number>(0);
  // 记录上一次的 scrollHeight，用于排除内容缩小导致的 scrollTop 变化误判为用户向上滚动
  const lastScrollHeightRef = useRef<number>(0);

  // 🎯 新增：编辑状态管理
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingOriginalMessage, setEditingOriginalMessage] = useState<ChatMessage | null>(null);

  // 🎯 新增：队列编辑状态管理
  const [editingQueueMessageId, setEditingQueueMessageId] = useState<string | null>(null);
  const [editingQueueContent, setEditingQueueContent] = useState<MessageContent | undefined>(undefined);

  // 🎯 新增：编辑确认对话框状态
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingEditData, setPendingEditData] = useState<{messageId: string, newContent: MessageContent} | null>(null);


  // 🎯 发送锁，防止在状态更新间隙重复发送
  // const [isSendingQueue, setIsSendingQueue] = useState(false);

  // 🎯 待移除的消息ID
  // const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  // 🎯 监听 isLoading 变化来重置锁
  // useEffect(() => {
  //   if (isLoading || isProcessing) {
  //     // 当系统开始处理时，重置发送锁，以便在处理完成后允许发送下一条
  //     setIsSendingQueue(false);
  //
  //     // 🎯 如果有待移除的消息，说明发送成功了，现在移除
  //     if (pendingRemoveId) {
  //       console.log('🎯 [QUEUE] Message sent successfully (loading started), removing from queue:', pendingRemoveId);
  //       if (onRemoveMessageFromQueue) {
  //         onRemoveMessageFromQueue(pendingRemoveId);
  //       }
  //       setPendingRemoveId(null);
  //     }
  //   }
  // }, [isLoading, isProcessing, pendingRemoveId, onRemoveMessageFromQueue]);

  // 🎯 自动发送队列中的消息 - 已移至 MultiSessionApp 全局处理
  // useEffect(() => {
  //   // 只有当完全空闲（既不loading也不processing）且队列有消息且未在发送中且没有待移除的消息时才发送
  //   if (!isLoading && !isProcessing && messageQueue.length > 0 && !isSendingQueue && !pendingRemoveId) {
  //     const nextMessage = messageQueue[0];
  //     console.log('🎯 [QUEUE] Auto-sending queued message:', nextMessage.id);
  //
  //     // 🔒 锁住，防止在 isLoading 变为 true 之前再次触发
  //     setIsSendingQueue(true);
  //     setPendingRemoveId(nextMessage.id); // 标记这条消息等待移除
  //
  //     // 发送消息
  //     onSendMessage(nextMessage.content);
  //
  //     // 注意：这里不再立即移除，而是等待 isLoading 变为 true
  //   }
  // }, [isLoading, isProcessing, messageQueue, onSendMessage, isSendingQueue, pendingRemoveId]);

  // 🎯 监听 isLoading 变化来重置锁
  useEffect(() => {
    if (isLoading || isProcessing) {
      // 🎯 当 AI 开始处理新任务时，强制开启自动滚动
      // 这解决了用户发送新消息后，如果之前处于停止滚动状态，新消息不会自动跟随的问题
      shouldAutoScrollRef.current = true;

      // 立即滚动到底部
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [isLoading, isProcessing]);

  // 智能滚动：根据用户位置自动滚动到底部
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || messages.length === 0) return;

    const performScrollCheck = () => {
      if (messages.length === 1 || shouldAutoScrollRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    };

    requestAnimationFrame(performScrollCheck);
  }, [messages]);

  // ResizeObserver 补充方案：监听滚动区域内容高度变化
  // 用于捕获 mermaid SVG 等异步渲染内容撑高页面的场景
  // messages 不变但内容高度增加时（如图表渲染完成），触发滚动
  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    });

    // 观察 scrollArea 内所有直接子元素，捕获任意子树高度变化
    Array.from(scrollArea.children).forEach(child => observer.observe(child));

    // 当 messages 新增时，新的子元素需要重新绑定
    const mutationObserver = new MutationObserver(() => {
      Array.from(scrollArea.children).forEach(child => observer.observe(child));
    });
    mutationObserver.observe(scrollArea, { childList: true });

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  // 🎯 监听滚动事件，检测用户位置和手动滚动
  useEffect(() => {
    const container = scrollAreaRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;

      // 🎯 阈值分离策略：
      // 1. 自动滚动判定：必须紧贴底部 (20px)
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 20;

      // 2. 按钮显示判定：离开底部一定距离 (300px)
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 300;

      // 🎯 磁吸逻辑：
      const isForcedAutoScroll = Date.now() - lastScrollClickTimeRef.current < 1000;

      // 🎯 关键修复：基于滚动方向的智能判断
      // 只有当用户"向上"滚动，且确实离开了底部时，才关闭自动滚动。
      // 这样可以防止 AI 输出长内容导致页面瞬间变长（此时 scrollTop 不变或增加）时误判为用户停止滚动。
      if (
        scrollTop < lastScrollTopRef.current &&
        scrollHeight >= lastScrollHeightRef.current && // 排除内容缩小（如mermaid错误）导致的scrollTop变化
        !isAtBottom &&
        !isForcedAutoScroll
      ) {
        shouldAutoScrollRef.current = false;
      }
      // 如果用户回到了底部，或者处于磁吸状态，重新开启自动滚动
      else if (isAtBottom || isForcedAutoScroll) {
        shouldAutoScrollRef.current = true;
      }

      // 更新 lastScrollTop 和 lastScrollHeight
      lastScrollTopRef.current = scrollTop;
      lastScrollHeightRef.current = scrollHeight;

      // 显示/隐藏滚动到底部按钮 (UI状态更新可以异步)
      setShowScrollToBottom(!isNearBottom && messages.length > 0);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messages]);

  // 🎯 计算修改的文件
  useEffect(() => {
    const filesMap = extractModifiedFiles(messages, undefined, propLastAcceptedMessageId || undefined);
    setModifiedFiles(filesMap);
  }, [messages, propLastAcceptedMessageId]);

  // 🎯 提取最新的任务列表 (Todos)
  const latestTodos = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.associatedToolCalls) {
        // 从后往前找最后一个成功的 todo_display
        for (let j = msg.associatedToolCalls.length - 1; j >= 0; j--) {
          const toolCall = msg.associatedToolCalls[j];
          const result = toolCall.result as any;
          const dataType = result?.data?.type || result?.type;
          if (dataType === 'todo_display' && toolCall.status === 'success') {
            return result.data || result;
          }
        }
      }
    }
    return null;
  }, [messages]);

  // 🎯 处理 AI 状态变化对 Todo 面板的影响
  useEffect(() => {
    const isCurrentlyActive = isLoading || isProcessing;

    // AI 结束时自动折叠 (从 active 变为 idle)
    if (prevProcessingRef.current && !isCurrentlyActive && isTodoVisible) {
      console.log('🎯 [Todo] AI finished, auto-collapsing todo panel');
      setIsTodoCollapsed(true);
    }

    prevProcessingRef.current = isCurrentlyActive;
  }, [isLoading, isProcessing, isTodoVisible]);

  // 🎯 监听最新 Todo 的产生
  useEffect(() => {
    if (latestTodos && (isLoading || isProcessing)) {
      // 🎯 检查是否是本回合产生的新更新 (AI 本轮显式调用了 todo_write)
      const currentSignature = JSON.stringify(latestTodos.items);
      const isNewUpdate = currentSignature !== turnStartTodoSignatureRef.current;

      if (isNewUpdate) {
        // 🎯 核心逻辑：上一轮未完成的 Todo 不再带入本轮显示
        // 只有当 AI 在本轮对话中产生了新的更新时，才重新显示并展开面板
        console.log('🎯 [Todo] Showing panel. Reason: New update produced by AI in this turn');
        setIsTodoVisible(true);
        setIsTodoCollapsed(false);
      }
    }
  }, [latestTodos, isLoading, isProcessing]);

  // 🎯 编辑模式下的键盘快捷键支持
  useEffect(() => {
    if (!editingMessageId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        console.log('🎯 用户按下Escape键，取消编辑');
        handleCancelEdit();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editingMessageId]);

  // 🎯 点击外部区域取消编辑
  useEffect(() => {
    if (!editingMessageId) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;

      // 检查点击是否在编辑器区域内
      const editingElement = document.querySelector(`[data-message-id="${editingMessageId}"]`);

      if (editingElement && !editingElement.contains(target) ) {
        console.log('🎯 用户点击外部区域，取消编辑');
        handleCancelEdit();
      }
    };

    // 延迟添加事件监听器，避免立即触发
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [editingMessageId]);

  // 🎯 滚动到底部函数
  const scrollToBottom = () => {
    // 立即隐藏按钮，避免滚动过程中闪现
    setShowScrollToBottom(false);
    // 强制启用自动滚动
    shouldAutoScrollRef.current = true;
    // 🎯 记录点击时间，激活"磁吸"逻辑
    lastScrollClickTimeRef.current = Date.now();

    // 开始滚动
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });

    // 延迟1.5秒后重新检查是否需要显示按钮
    setTimeout(() => {
      // 🎯 修正：使用 scrollAreaRef
      if (scrollAreaRef.current) {
        const container = scrollAreaRef.current;
        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const clientHeight = container.clientHeight;
        const isNearBottom = scrollTop + clientHeight >= scrollHeight - 50;

        // 如果用户在延迟期间又滚动了，且不在底部，则重新显示按钮
        if (!isNearBottom && messages.length > 0) {
          setShowScrollToBottom(true);
        }
      }
    }, 1500);
  };

  // 🎯 强制滚动到底部（用于发送消息后）
  const forceScrollToBottom = () => {
    // 重置用户滚动状态，确保自动滚动生效
    shouldAutoScrollRef.current = true;
    // 立即滚动到底部
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 0);
  };

  // 🎯 处理发送消息并自动滚动到底部
  const handleSendMessage = (content: MessageContent) => {
    // 🎯 强制开启自动滚动
    shouldAutoScrollRef.current = true;

    // 🎯 隐藏上一轮的 Todo 面板
    setIsTodoVisible(false);

    // 🎯 记录回合开始时的 Todo 签名，用于判断下一轮是否显示
    turnStartTodoSignatureRef.current = latestTodos ? JSON.stringify(latestTodos.items) : "";

    // 🎯 如果正在处理中，加入队列
    if ((isLoading || isProcessing) && onAddMessageToQueue) {
      console.log('🎯 [QUEUE] System busy, adding message to queue');
      onAddMessageToQueue(content);
      forceScrollToBottom();
      return;
    }

    // 调用原始的发送消息函数
    onSendMessage(content);
    // 自动滚动到底部
    forceScrollToBottom();
  };

  // 🎯 处理重新生成消息
  const handleRegenerate = (messageId: string) => {
    // 找到要重新生成的消息
    const message = messages.find(msg => msg.id === messageId);
    if (!message || message.type !== 'assistant') {
      console.error('无法重新生成：消息类型错误');
      return;
    }

    // 找到该消息的索引
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    if (messageIndex < 0) {
      console.error('无法重新生成：未找到消息');
      return;
    }

    // 查找最近的用户消息及其索引
    let userMessage: ChatMessage | undefined;
    let userMessageIndex = -1;
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        userMessage = messages[i];
        userMessageIndex = i;
        break;
      }
    }

    if (!userMessage || userMessageIndex === -1) {
      console.error('无法重新生成：未找到对应的用户消息');
      return;
    }

    // 🎯 保留原用户消息，只删除助手回答及之后的所有消息
    // 这样用户消息保持不变（ID和内容都不变）
    const newMessages = messages.slice(0, userMessageIndex + 1); // 保留到用户消息（包含）

    // 更新消息列表
    if (onUpdateMessages) {
      onUpdateMessages(newMessages);
    }

    // 🎯 强制开启自动滚动
    shouldAutoScrollRef.current = true;

    // 🎯 使用消息服务直接发送聊天请求，不通过onSendMessage（避免重复创建用户消息）
    const messageService = getGlobalMessageService();
    if (sessionId && messageService) {
      // 延迟发送，确保消息列表已更新
      setTimeout(() => {
        // 使用编辑并重新生成接口，避免在后端重复创建/追加用户消息
        messageService.sendEditMessageAndRegenerate(
          sessionId,
          userMessage.id,
          userMessage.content,
          messages // 传递原始完整消息历史，供后端回滚/分析使用
        );
        forceScrollToBottom();
      }, 50);
    } else {
      console.error('无法重新生成：缺少sessionId或messageService');
    }
  };

  // 🎯 新增：将工具调用移到后台执行
  const handleMoveToBackground = (toolCallId: string) => {
    console.log('🎯 [ChatInterface] Moving tool call to background:', toolCallId);
    if (typeof window !== 'undefined' && window.vscode) {
      window.vscode.postMessage({
        type: 'background_task_move_to_background',
        payload: {
          toolCallId,
          sessionId
        }
      });
    }
  };

  // 🎯 新增：编辑功能处理函数
  const handleStartEdit = (messageId: string) => {
    const message = messages.find(msg => msg.id === messageId);

    if (!message || message.type !== 'user') {
      return;
    }

    // 🎯 检查是否可以回滚（有对应的prompt_id）
    if (!rollbackableMessageIds.includes(messageId)) {
      console.warn('🎯 消息无法编辑，没有对应的AI历史记录:', { messageId });
      // 这里可以显示用户友好的提示消息
      return;
    }

    console.log('🎯 开始编辑消息:', { messageId, message, canRollback: true });
    setEditingMessageId(messageId);
    setEditingOriginalMessage(message);

    // 🎯 滚动到编辑的消息位置
    setTimeout(() => {
      const editingElement = document.querySelector(`[data-message-id="${messageId}"]`);
      if (editingElement) {
        editingElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  };

  const handleSaveEdit = (messageId: string, newContent: MessageContent) => {
    console.log('🎯 保存编辑消息:', {
      messageId,
      newContent,
      originalMessage: editingOriginalMessage
    });

    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) {
      console.error('🎯 未找到要编辑的消息:', messageId);
      return;
    }

    const subsequentMessagesCount = messages.length - messageIndex - 1;

    console.log('🎯 消息编辑详情:');
    console.log('  - 消息ID:', messageId);
    console.log('  - 消息位置:', messageIndex, '/', messages.length);
    console.log('  - 原始内容:', editingOriginalMessage?.content);
    console.log('  - 新内容:', newContent);
    console.log('  - 后续消息数量:', subsequentMessagesCount);

    // 🎯 如果有后续消息，显示确认对话框
    if (subsequentMessagesCount > 0) {
      setPendingEditData({ messageId, newContent });
      setShowConfirmDialog(true);
    } else {
      // 🎯 没有后续消息，直接执行编辑
      executeEdit(messageId, newContent);
    }
  };

  // 🎯 执行编辑操作
  const executeEdit = async (messageId: string, newContent: MessageContent) => {
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) return;

    try {
      console.log('🎯 开始执行编辑操作');

      // 🎯 1. 截断消息历史到编辑位置
      const truncatedMessages = messages.slice(0, messageIndex);

      // 🎯 2. 更新编辑的消息内容
      const updatedMessage = {
        ...messages[messageIndex],
        content: newContent,
        timestamp: Date.now() // 更新时间戳
      };

      // 🎯 3. 创建新的消息数组（包含更新后的编辑消息）
      const newMessages = [...truncatedMessages, updatedMessage];

      console.log('🎯 消息历史已截断:', {
        原始消息数量: messages.length,
        截断后数量: newMessages.length,
        删除的消息数: messages.length - newMessages.length,
        编辑的消息ID: messageId
      });

      if (onAbortProcess) {
        onAbortProcess();
      }

      // 🎯 4. 立即更新UI中的消息列表
      if (onUpdateMessages) {
        console.log('🎯 立即更新UI消息列表');
        onUpdateMessages(newMessages);
      }

      // 🎯 5. 通过多Session消息服务发送编辑请求
      // 🎯 重要：传递完整的消息历史给后端，这样FileRollbackService可以分析所有文件修改
      console.log('🎯 发送编辑消息请求到AI服务（包含完整消息历史）');

      // 使用多Session消息服务发送编辑请求，传递原始的完整消息历史
      getGlobalMessageService().sendEditMessageAndRegenerate(
        sessionId || '',
        messageId,
        newContent,
        messages // 🎯 传递原始的完整消息历史用于文件回滚分析
      );

      // 🎯 6. 清空编辑状态
      setEditingMessageId(null);
      setEditingOriginalMessage(null);

      // 🎯 7. 触发滚动到底部
      forceScrollToBottom();

    } catch (error) {
      console.error('🎯 编辑操作失败:', error);
      // TODO: 显示错误提示
    }
  };

  // 🎯 确认编辑回滚
  const handleConfirmEdit = () => {
    if (pendingEditData) {
      executeEdit(pendingEditData.messageId, pendingEditData.newContent);
      setPendingEditData(null);
    }
    setShowConfirmDialog(false);
  };

  // 🎯 取消编辑回滚
  const handleCancelEditConfirm = () => {
    setPendingEditData(null);
    setShowConfirmDialog(false);
  };

  // 🎯 队列消息编辑处理函数
  const handleSaveQueueEdit = (messageId: string, newContent: MessageContent) => {
    console.log('🎯 保存队列编辑消息:', { messageId, newContent });
    if (onUpdateMessageQueue) {
      const newQueue = messageQueue.map(item =>
        item.id === messageId
          ? { ...item, content: newContent }
          : item
      );
      onUpdateMessageQueue(newQueue);
    }
    setEditingQueueMessageId(null);
    setEditingQueueContent(undefined);
  };

  const handleCancelQueueEdit = () => {
    console.log('🎯 取消队列编辑');
    setEditingQueueMessageId(null);
    setEditingQueueContent(undefined);
  };

  /**
   * 🎯 处理回退到指定消息
   *
   * 功能说明：
   * - 回退操作会删除目标消息之后的所有消息
   * - 同时会将文件系统回滚到该消息时的状态
   * - 直接执行，无需二次确认
   *
   * 执行流程：
   * 1. 验证目标消息有效性
   * 2. 中断当前正在进行的AI处理
   * 3. 截断UI中的消息历史
   * 4. 发送回退请求到后端进行文件回滚
   * 5. 后端会回滚文件到目标消息时的状态
   *
   * @param messageId - 要回退到的目标消息ID
   */
  const handleRollback = async (messageId: string) => {
    // 🔍 1. 验证目标消息是否存在
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) {
      console.error('🎯 回退失败：找不到目标消息', { messageId });
      return;
    }

    // 🔍 2. 检查是否是最后一条消息（最后一条消息不应该显示回退按钮，但做双重保险）
    const isLastMessage = messageIndex === messages.length - 1;
    if (isLastMessage) {
      console.warn('🎯 无法回退：这是最后一条消息');
      return;
    }

    // 🔍 3. 计算将被删除的消息数量
    const messagesWillBeDeleted = messages.length - messageIndex - 1;

    console.log('🎯 开始执行回退操作:', {
      目标消息ID: messageId,
      目标消息索引: messageIndex,
      当前消息总数: messages.length,
      将删除的消息数: messagesWillBeDeleted
    });

    try {
      // ✅ 步骤1: 中断当前进程（如果有AI正在生成回复）
      if (onAbortProcess) {
        console.log('🎯 中断当前AI处理流程');
        onAbortProcess();
      }

      // ✅ 步骤2: 截断消息历史到目标消息（包含目标消息本身）
      const newMessages = messages.slice(0, messageIndex + 1);

      console.log('🎯 消息历史已截断:', {
        原始消息数量: messages.length,
        截断后数量: newMessages.length,
        删除的消息数: messages.length - newMessages.length
      });

      // ✅ 步骤3: 立即更新UI中的消息列表（提供即时反馈）
      if (onUpdateMessages) {
        console.log('🎯 立即更新UI消息列表');
        onUpdateMessages(newMessages);
      }

      // ✅ 步骤4: 发送回退请求到后端
      // 后端会：
      // - 分析目标消息之后所有的文件修改
      // - 将这些文件回滚到目标消息时的状态
      // - 回滚AI的对话历史
      console.log('🎯 发送回退请求到后端（包含完整消息历史用于文件分析）');

      getGlobalMessageService().sendRollbackToMessage(
        sessionId || '',
        messageId,
        messages  // ⭐ 传递原始完整消息历史，后端需要分析所有文件修改
      );

      // ✅ 步骤5: 触发滚动到底部，让用户看到最新状态
      forceScrollToBottom();

      console.log('✅ 回退操作已触发，等待后端文件回滚完成');

    } catch (error) {
      console.error('❌ 回退操作失败:', error);

      // 错误已经记录到控制台，后端会通过 sendChatError 向前端发送错误消息
      // 前端会在聊天界面显示错误提示
    }
  };

  const handleCancelEdit = () => {
    console.log('🎯 取消编辑消息:', {
      editingMessageId,
      originalMessage: editingOriginalMessage
    });

    // 清空编辑状态
    setEditingMessageId(null);
    setEditingOriginalMessage(null);
  };

  // 🎯 处理文件点击 - 在编辑器中打开diff
  const handleFileClick = (file: ModifiedFile) => {
    if (typeof window !== 'undefined' && window.vscode) {
      if (file.isDeletedFile) {
        // 对于删除的文件，显示原始内容
        window.vscode.postMessage({
          type: 'openDeletedFileContent',
          payload: {
            fileName: file.fileName,
            filePath: file.absolutePath || file.filePath, // 🎯 优先使用绝对路径
            deletedContent: file.deletedContent || file.firstOriginalContent
          }
        });
      } else {
        // 对于修改或新建的文件，显示diff
        window.vscode.postMessage({
          type: 'openDiffInEditor',
          payload: {
            fileDiff: file.latestFileDiff,
            fileName: file.fileName,
            filePath: file.absolutePath || file.filePath, // 🎯 优先使用绝对路径
            originalContent: file.firstOriginalContent,
            newContent: file.latestNewContent
          }
        });
      }
    }
  };

  // 🎯 处理接受文件变更
  const handleAcceptChanges = () => {
    // 找到最后一条消息的ID
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && onSetLastAcceptedMessageId) {
      const newAcceptedId = lastMessage.id;
      onSetLastAcceptedMessageId(newAcceptedId);

      // 发送消息给后端保存状态
      if (typeof window !== 'undefined' && window.vscode) {
        window.vscode.postMessage({
          type: 'acceptFileChanges',
          payload: {
            lastAcceptedMessageId: newAcceptedId
          }
        });
      }
    }
  };

  /**
   * 🎯 处理撤销单个文件的变更
   * @param file - 目标文件
   */
  const handleUndoFile = (file: ModifiedFile) => {
    if (!sessionId) return;

    console.log('🎯 [Undo] Requesting undo for file:', file.fileName);

    getGlobalMessageService().undoFileChange(sessionId, {
      fileName: file.fileName,
      filePath: file.absolutePath || file.filePath, // 🎯 优先使用绝对路径
      originalContent: file.firstOriginalContent,
      isNewFile: file.isNewFile,
      isDeletedFile: file.isDeletedFile
    });

    // 🎯 将撤销记录加入对话历史，让 AI 知晓
    const undoMsg: ChatMessage = {
      id: `undo-msg-${Date.now()}`,
      type: 'system',
      content: createTextMessageContent(t('chat.undoneFileHistory', { fileName: file.fileName })),
      timestamp: Date.now(),
      // 🎯 添加元数据，以便 fileChangeExtractor 能够识别并从列表中移除
      notificationType: 'undo_file' as any,
      notificationTitle: file.absolutePath || file.filePath || file.fileName
    };

    if (onUpdateMessages) {
      onUpdateMessages([...messages, undoMsg]);
    }

    // 同步保存到后端
    getGlobalMessageService().saveUIMessage(sessionId, undoMsg);

    // 🎯 提示用户
    // vscode.window.showInformationMessage 会在后端处理
  };

  return (
    <div className="chat-interface">


      {/* Messages Area */}
      <div className="messages-container" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div className="welcome-message">
            <div className="welcome-content">
              <h2>
                👋 {t('welcome.titleMain')}
                <br />
                <span className="welcome-subtitle">{t('welcome.titleSub')}</span>
              </h2>
              <p>{t('welcome.description')}</p>

            </div>
          </div>
        ) : (
          <>
            {/* 🎯 消息滚动区域 */}
            <div className="messages-scroll-area" ref={scrollAreaRef}>
              {(() => {
                // 🎯 提前计算最后一条助手消息的索引（优化性能，避免每次渲染都计算）
                let lastAssistantMessageIndex = -1;
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i].type === 'assistant') {
                    lastAssistantMessageIndex = i;
                    break;
                  }
                }

                return messages.map((message, index) => {
                  // 🎯 判断是否是最后一条助手消息
                  const isLastAssistantMessage = index === lastAssistantMessageIndex;

                  return (
                  <div key={message.id} data-message-id={message.id}>
                    {/* 🎯 如果是正在编辑的用户消息，显示编辑器 */}
                    {message.type === 'user' && editingMessageId === message.id ? (
                      <div className="message-bubble user-message editing">
                        <MessageInput
                          mode="edit"
                          editingMessageId={message.id}
                          initialContent={message.content}
                          onSendMessage={onSendMessage} // 🎯 编辑模式下不会调用这个，但是接口需要
                          onSaveEdit={handleSaveEdit}
                          onCancelEdit={handleCancelEdit}
                          isLoading={false}
                          isProcessing={false}
                          selectedModelId={selectedModelId}
                          onModelChange={onModelChange}
                          sessionId={sessionId}
                          tokenUsage={tokenUsage}
                          showModelSelector={true}
                          showTokenUsage={false}
                          compact={true}
                          className="message-editor"
                          placeholder="编辑你的消息..."
                          isPlanMode={isPlanMode}
                          onTogglePlanMode={onTogglePlanMode}
                          messages={messages}
                        />
                      </div>
                    ) : (
                      <MessageBubble
                        message={message}
                        onToolConfirm={onToolConfirm}
                        onStartEdit={message.type === 'user' && rollbackableMessageIds.includes(message.id) ? handleStartEdit : undefined}
                        onRegenerate={isLastAssistantMessage ? handleRegenerate : undefined}
                        onRollback={
                          // 🎯 回退按钮显示条件：
                          // 1. 必须是用户消息
                          // 2. 必须在可回滚消息列表中
                          // 🔧 FIX: 移除 index < messages.length - 1 条件，因为这在消息列表变化时会导致按钮闪现/消失
                          // 回退功能本身会检查后续消息是否需要删除
                          message.type === 'user' &&
                          rollbackableMessageIds.includes(message.id)
                            ? handleRollback
                            : undefined
                        }
                        canRevert={message.type === 'user' && rollbackableMessageIds.includes(message.id)}
                        sessionId={sessionId}
                        messages={messages}
                        onUpdateMessages={onUpdateMessages}
                        onMoveToBackground={handleMoveToBackground}
                      />
                    )}
                  </div>
                  );
                });
              })()}
              <div ref={messagesEndRef} />
            </div>

            {/* 🎯 固定在底部的加载指示器 */}
            <div className="messages-loading-footer">
              {/* 🎯 服务初始化/准备中 - 显示"Planning next moves..." */}
              {isLoading && !isProcessing && (
                <div className="loading-message">
                  <div className="loading-indicator">
                    <div className="loading-dots">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                    <span className="loading-text">Planning next moves...</span>
                  </div>
                </div>
              )}

              {/* 🎯 执行中状态显示 */}
              {isProcessing && (
                <div className="processing-message">
                  <div className="processing-indicator">
                    <svg className="processing-spinner" viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2"/>
                      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="15.7 62.8" strokeLinecap="round"/>
                    </svg>
                    <div className="processing-text-wrapper">
                      <span className="processing-text">Generating response...</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Background Tasks Bar - 放在 Files Changed Bar 上方 */}
      {!isTasksBarDismissed && (
        <BackgroundTasksBar
          tasks={backgroundTasks}
          runningCount={backgroundRunningCount}
          onKillTask={killBackgroundTask}
          onClose={() => setIsTasksBarDismissed(true)}
        />
      )}

      {/* Files Changed Bar */}
      <FilesChangedBar
        modifiedFiles={modifiedFiles}
        onFileClick={handleFileClick}
        onUndoFile={handleUndoFile}
        onAcceptChanges={handleAcceptChanges}
      />

      {/* 🎯 悬浮任务列表 (Sticky Todos) */}
      {latestTodos && isTodoVisible && (
        <StickyTodoPanel
          data={latestTodos}
          isCollapsed={isTodoCollapsed}
          onToggleCollapse={(collapsed) => setIsTodoCollapsed(collapsed)}
        />
      )}

      {/* 🎯 编辑确认对话框 */}
      {showConfirmDialog && (
        <div className="confirm-dialog-overlay" onClick={handleCancelEditConfirm}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-header">
              <AlertTriangle size={16} color="var(--vscode-editorWarning-foreground)" />
              <h3>{t('chat.editConfirm.title')}</h3>
            </div>
            <div className="confirm-dialog-content">
              <p>{t('chat.editConfirm.content', { count: pendingEditData && messages.findIndex(m => m.id === pendingEditData.messageId) !== -1 ?
                messages.length - messages.findIndex(m => m.id === pendingEditData.messageId) - 1 : 0 })}</p>
              <p>{t('chat.editConfirm.warning')}</p>
            </div>
            <div className="confirm-dialog-actions">
              <button
                className="confirm-dialog-button secondary"
                onClick={handleCancelEditConfirm}
              >
                {t('chat.editConfirm.cancel')}
              </button>
              <button
                className="confirm-dialog-button primary"
                onClick={handleConfirmEdit}
              >
                {t('chat.editConfirm.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🎯 滚动到底部按钮 - 悬浮在输入框上方 */}
      {showScrollToBottom && (
        <div style={{
          position: 'relative',
          height: '0',
          zIndex: 100
        }}>
          <button
            onClick={scrollToBottom}
            style={{
              position: 'absolute',
              bottom: '12px', // 输入框上方一点点
              right: '20px',
              backgroundColor: 'rgba(14, 99, 156, 0.85)', // 稍微提高透明度
              color: 'var(--vscode-button-foreground)',
              border: '1px solid rgba(14, 99, 156, 0.6)',
              borderRadius: '50%',
              width: '32px', // 更小巧
              height: '32px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '14px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(6px)',
              transition: 'all 0.2s ease',
              animation: 'fadeIn 0.3s ease-in'
            }}
            title={t('chat.scrollToBottom')}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(17, 119, 187, 0.95)';
              e.currentTarget.style.transform = 'scale(1.1)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(14, 99, 156, 0.85)';
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            <ArrowDown size={14} />
          </button>
        </div>
      )}

      {/* 🎯 消息队列显示 */}
      <MessageQueueList
        queue={messageQueue}
        onRemove={(id) => onRemoveMessageFromQueue?.(id)}
        onReorder={(newQueue) => onUpdateMessageQueue?.(newQueue)}
        onEdit={(item) => {
          // 🎯 修复：编辑队列消息时，进入编辑模式
          setEditingQueueMessageId(item.id);
          setEditingQueueContent(item.content);
        }}
      />

      {/* Input Area */}
      <MessageInput
        ref={messageInputRef}
        isLoading={isLoading}
        isProcessing={isProcessing}
        isModelSwitching={isModelSwitching} // 🎯 传入模型切换状态
        canAbort={canAbort}
        onSendMessage={handleSendMessage}
        onAbortProcess={onAbortProcess}
        selectedModelId={selectedModelId}
        onModelChange={onModelChange}
        sessionId={sessionId}
        tokenUsage={tokenUsage}
        isPlanMode={isPlanMode}
        onTogglePlanMode={onTogglePlanMode}
        messages={messages}
        // 🎯 队列消息编辑 props
        mode={editingQueueMessageId ? 'edit' : 'compose'}
        editingMessageId={editingQueueMessageId || undefined}
        initialContent={editingQueueContent}
        onSaveEdit={handleSaveQueueEdit}
        onCancelEdit={handleCancelQueueEdit}
      />
    </div>
  );
};
