import { useState, useRef, useEffect, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ReactMarkdown from 'react-markdown';
import './App.css';

import outputs from '../amplify_outputs.json';

const AGENT_ARN = outputs.custom?.agentRuntimeArn;

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbzwCOqbjwUkbry-Y5KLENR_8I8iQeNrkBVgJx-ec6RV04K4fihEEWAB1SE8PIDLn2MTiA/exec';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isToolUsing?: boolean;
  toolCompleted?: boolean;
  toolName?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
    });
  }, [messages]);

  // =========================================================
  // AgentCoreへ送信
  // =========================================================
  const sendMessage = async (text: string) => {
    const userText = text.trim();

    if (!userText || loading) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
    };

    const updatedHistory: ChatMessage[] = [
      ...chatHistory,
      {
        role: 'user',
        content: userText,
      },
    ];

    setChatHistory(updatedHistory);

    setMessages((prev) => [
      ...prev,
      userMessage,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
      },
    ]);

    setInput('');
    setLoading(true);

    try {
      // =====================================================
      // Cognito
      // =====================================================
      const session = await fetchAuthSession();

      const accessToken =
        session.tokens?.accessToken?.toString();

      if (!accessToken) {
        throw new Error(
          '認証トークンを取得できませんでした'
        );
      }

      // =====================================================
      // AgentCore
      // =====================================================
      const url =
        `https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/` +
        `${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: userText,
          history: updatedHistory,
        }),
      });

      if (!res.ok) {
        throw new Error(
          `AgentCore API error: ${res.status} ${res.statusText}`
        );
      }

      if (!res.body) {
        throw new Error('レスポンスボディがありません');
      }

      // =====================================================
      // SSE
      // =====================================================
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = '';
      let isInToolUse = false;
      let toolIdx = -1;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const decoded = decoder.decode(value, {
          stream: true,
        });

        for (const line of decoded.split('\n')) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);

          if (data === '[DONE]') continue;

          let event;

          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // =================================================
          // ツール使用開始
          // =================================================
          if (event.type === 'tool_use') {
            isInToolUse = true;

            const savedBuffer = buffer;

            setMessages((prev) => {
              const msgs = [...prev];

              if (savedBuffer) {
                msgs[msgs.length - 1] = {
                  ...msgs[msgs.length - 1],
                  content: savedBuffer,
                };

                toolIdx = msgs.length;

                msgs.push({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: '',
                  isToolUsing: true,
                  toolName: event.tool_name,
                });
              } else {
                toolIdx = msgs.length - 1;

                msgs[msgs.length - 1] = {
                  ...msgs[msgs.length - 1],
                  isToolUsing: true,
                  toolName: event.tool_name,
                };
              }

              return msgs;
            });

            buffer = '';

            continue;
          }

          // =================================================
          // AIテキスト
          // =================================================
          if (event.type === 'text' && event.data) {
            if (isInToolUse && !buffer) {
              const savedIdx = toolIdx;

              setMessages((prev) => {
                const msgs = [...prev];

                if (
                  savedIdx >= 0 &&
                  savedIdx < msgs.length
                ) {
                  msgs[savedIdx] = {
                    ...msgs[savedIdx],
                    toolCompleted: true,
                  };
                }

                msgs.push({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: event.data,
                });

                return msgs;
              });

              buffer = event.data;
              isInToolUse = false;
              toolIdx = -1;
            } else {
              buffer += event.data;

              const displayText = buffer
                .replace(
                  /<EXPENSE>[\s\S]*?<\/EXPENSE>/g,
                  ''
                )
                .trim();

              setMessages((prev) => {
                const msgs = [...prev];

                msgs[msgs.length - 1] = {
                  ...msgs[msgs.length - 1],
                  content: displayText,
                  isToolUsing: false,
                };

                return msgs;
              });
            }
          }
        }
      }

      // =====================================================
      // 会話履歴
      // =====================================================
      const cleanResponse = buffer
        .replace(
          /<EXPENSE>[\s\S]*?<\/EXPENSE>/g,
          ''
        )
        .trim();

      if (cleanResponse) {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: cleanResponse,
          },
        ]);
      }

      // =====================================================
      // EXPENSE
      // =====================================================
      const expenseMatch = buffer.match(
        /<EXPENSE>\s*(\{[\s\S]*?\})\s*<\/EXPENSE>/
      );

      if (expenseMatch) {
        try {
          const expense = JSON.parse(expenseMatch[1]);

          const amount = Number(expense.amount);

          if (!Number.isFinite(amount)) {
            throw new Error(
              `金額が数値ではありません: ${expense.amount}`
            );
          }

          const gasResponse = await fetch(GAS_URL, {
            method: 'POST',

            headers: {
              'Content-Type': 'text/plain;charset=utf-8',
            },

            body: JSON.stringify({
              action: expense.action || 'add',
              person: expense.person,
              category: expense.category,
              amount: amount,
            }),
          });

          const gasResult = await gasResponse.json();

          console.log('GAS response:', gasResult);
        } catch (error) {
          console.error(
            '家計簿登録・キャンセルエラー:',
            error
          );
        }
      }

      // =====================================================
      // だじょ
      // =====================================================
      setMessages((prev) => {
        const msgs = [...prev];

        const last =
          msgs[msgs.length - 1];

        if (
          last &&
          last.role === 'assistant' &&
          last.content
        ) {
          msgs[msgs.length - 1] = {
            ...last,
            content:
              last.content + 'だじょ',
          };
        }

        return msgs;
      });
    } catch (error) {
      console.error(
        'AIチャットエラー:',
        error
      );

      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error);

      setMessages((prev) => {
        const msgs = [...prev];

        const last =
          msgs[msgs.length - 1];

        if (
          last &&
          last.role === 'assistant'
        ) {
          msgs[msgs.length - 1] = {
            ...last,
            content:
              `AIとの通信に失敗したんだじょ\n\nエラー: ${errorMessage}`,
          };
        }

        return msgs;
      });
    } finally {
      setLoading(false);
    }
  };

  // =========================================================
  // 通常入力
  // =========================================================
  const handleSubmit = async (
    e: FormEvent
  ) => {
    e.preventDefault();

    await sendMessage(input);
  };

  // =========================================================
  // 選択肢クリック
  // =========================================================
  const handleSuggestionClick = (
    command: string
  ) => {
    if (loading) return;

    // クリックした内容を即送信
    void sendMessage(command);
  };

  // =========================================================
  // AI回答を描画
  // =========================================================
  const renderAssistantContent = (
    content: string
  ) => {
    const lines = content.split('\n');

    return lines.map((line, index) => {
      // -----------------------------------------------
      // 「○○」という行をクリック可能なボタンにする
      // Markdownの "- 「○○」" に対応
      // -----------------------------------------------
      const match = line.match(
        /^\s*[-*]\s*「(.+)」\s*$/
      );

      if (match) {
        const command = match[1];

        return (
          <button
            key={index}
            type="button"
            className="suggestion-button"
            onClick={() =>
              handleSuggestionClick(command)
            }
            disabled={loading}
          >
            {command}
          </button>
        );
      }

      return (
        <div key={index}>
          <ReactMarkdown>
            {line}
          </ReactMarkdown>
        </div>
      );
    });
  };

  return (
    <div className="container">

      <header className="header">
        <h1 className="title">
          家計簿編集エージェントアプリ
        </h1>

        <p className="subtitle">
          みどぴ使うんだじょ
        </p>
      </header>

      <div
        className={`message-area ${
          messages.length === 0
            ? 'empty'
            : ''
        }`}
      >
        <div className="message-container">

          {messages.map((msg) => (

            <div
              key={msg.id}
              className={`message-row ${msg.role}`}
            >

              <div
                className={`bubble ${msg.role}`}
              >

                {/* AI考え中 */}
                {msg.role === 'assistant' &&
                  !msg.content &&
                  !msg.isToolUsing && (
                    <span className="thinking">
                      考え中…
                    </span>
                  )}

                {/* ツール使用 */}
                {msg.isToolUsing && (
                  <span
                    className={`tool-status ${
                      msg.toolCompleted
                        ? 'completed'
                        : 'active'
                    }`}
                  >
                    {msg.toolCompleted
                      ? '✓'
                      : '⏳'}{' '}

                    {msg.toolName}

                    {msg.toolCompleted
                      ? 'ツールを利用しました'
                      : 'ツールを利用中...'}
                  </span>
                )}

                {/* AI回答 */}
                {msg.content &&
                  !msg.isToolUsing && (
                    <div className="assistant-content">
                      {renderAssistantContent(
                        msg.content
                      )}
                    </div>
                  )}

              </div>

            </div>

          ))}

          <div ref={messagesEndRef} />

        </div>
      </div>

      {/* 入力 */}
      <div className="form-wrapper">

        <form
          onSubmit={handleSubmit}
          className="form"
        >

          <input
            value={input}
            onChange={(e) =>
              setInput(e.target.value)
            }
            placeholder="メッセージを入力..."
            disabled={loading}
            className="input"
          />

          <button
            type="submit"
            disabled={
              loading ||
              !input.trim()
            }
            className="button"
          >
            {loading
              ? '⌛️'
              : '送信'}
          </button>

        </form>

      </div>

    </div>
  );
}

export default App;