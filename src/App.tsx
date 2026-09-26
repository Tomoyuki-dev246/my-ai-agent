import {
  useState,
  useRef,
  useEffect,
  type FormEvent,
} from 'react';

import { fetchAuthSession } from 'aws-amplify/auth';
import ReactMarkdown from 'react-markdown';

import './App.css';

import outputs from '../amplify_outputs.json';

// =========================================================
// 設定
// =========================================================

const AGENT_ARN = outputs.custom?.agentRuntimeArn;

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbzwCOqbjwUkbry-Y5KLENR_8I8iQeNrkBVgJx-ec6RV04K4fihEEWAB1SE8PIDLn2MTiA/exec';

// =========================================================
// 型定義
// =========================================================

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

// =========================================================
// App
// =========================================================

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatHistory, setChatHistory] = useState<
    ChatMessage[]
  >([]);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const messagesEndRef =
    useRef<HTMLDivElement>(null);

  // =======================================================
  // メッセージ最下部へスクロール
  // =======================================================

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
    });
  }, [messages]);

  // =======================================================
  // AgentCoreへメッセージ送信
  // =======================================================

  const sendMessage = async (text: string) => {
    const userText = text.trim();

    if (!userText || loading) {
      return;
    }

    // =====================================================
    // ユーザーメッセージ
    // =====================================================

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
    };

    // =====================================================
    // 会話履歴
    // =====================================================

    const updatedHistory: ChatMessage[] = [
      ...chatHistory,
      {
        role: 'user',
        content: userText,
      },
    ];

    setChatHistory(updatedHistory);

    // =====================================================
    // 画面にユーザー発言＋AI待機を追加
    // =====================================================

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
      // ===================================================
      // Cognito認証トークン取得
      // ===================================================

      const session = await fetchAuthSession();

      const accessToken =
        session.tokens?.accessToken?.toString();

      if (!accessToken) {
        throw new Error(
          '認証トークンを取得できませんでした'
        );
      }

      // ===================================================
      // AgentCore Runtime API
      // ===================================================

      const url =
        `https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/` +
        `${encodeURIComponent(
          AGENT_ARN
        )}/invocations?qualifier=DEFAULT`;

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
        throw new Error(
          'レスポンスボディがありません'
        );
      }

      // ===================================================
      // SSEストリーミング
      // ===================================================

      const reader =
        res.body.getReader();

      const decoder =
        new TextDecoder();

      let buffer = '';

      let isInToolUse = false;

      let toolIdx = -1;

      while (true) {
        const {
          done,
          value,
        } = await reader.read();

        if (done) {
          break;
        }

        const decoded =
          decoder.decode(value, {
            stream: true,
          });

        for (
          const line of decoded.split('\n')
        ) {
          if (!line.startsWith('data: ')) {
            continue;
          }

          const data =
            line.slice(6);

          if (data === '[DONE]') {
            continue;
          }

          let event;

          try {
            event = JSON.parse(data);
          } catch (error) {
            console.error(
              'SSE JSON parse error:',
              error
            );

            continue;
          }

          // =================================================
          // ツール使用開始
          // =================================================

          if (
            event.type === 'tool_use'
          ) {
            isInToolUse = true;

            const savedBuffer =
              buffer;

            setMessages((prev) => {
              const msgs = [...prev];

              if (savedBuffer) {
                msgs[
                  msgs.length - 1
                ] = {
                  ...msgs[
                    msgs.length - 1
                  ],

                  content:
                    savedBuffer,
                };

                toolIdx =
                  msgs.length;

                msgs.push({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: '',
                  isToolUsing: true,
                  toolName:
                    event.tool_name,
                });
              } else {
                toolIdx =
                  msgs.length - 1;

                msgs[
                  msgs.length - 1
                ] = {
                  ...msgs[
                    msgs.length - 1
                  ],

                  isToolUsing: true,

                  toolName:
                    event.tool_name,
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

          if (
            event.type === 'text' &&
            event.data
          ) {
            if (
              isInToolUse &&
              !buffer
            ) {
              const savedIdx =
                toolIdx;

              setMessages((prev) => {
                const msgs = [...prev];

                if (
                  savedIdx >= 0 &&
                  savedIdx <
                    msgs.length
                ) {
                  msgs[
                    savedIdx
                  ] = {
                    ...msgs[
                      savedIdx
                    ],

                    toolCompleted:
                      true,
                  };
                }

                msgs.push({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content:
                    event.data,
                });

                return msgs;
              });

              buffer =
                event.data;

              isInToolUse = false;

              toolIdx = -1;
            } else {
              buffer +=
                event.data;

              // =============================================
              // EXPENSEタグを画面から隠す
              // =============================================

              const displayText =
                buffer
                  .replace(
                    /<EXPENSE>[\s\S]*?<\/EXPENSE>/g,
                    ''
                  )
                  .trim();

              setMessages((prev) => {
                const msgs = [...prev];

                msgs[
                  msgs.length - 1
                ] = {
                  ...msgs[
                    msgs.length - 1
                  ],

                  content:
                    displayText,

                  isToolUsing:
                    false,
                };

                return msgs;
              });
            }
          }
        }
      }

      // =====================================================
      // AI回答を会話履歴へ追加
      // =====================================================

      const cleanResponse =
        buffer
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
            content:
              cleanResponse,
          },
        ]);
      }

      // =====================================================
      // EXPENSE取得
      // =====================================================

      const expenseMatch =
        buffer.match(
          /<EXPENSE>\s*(\{[\s\S]*?\})\s*<\/EXPENSE>/
        );

      if (expenseMatch) {
        try {
          const expense =
            JSON.parse(
              expenseMatch[1]
            );

          // =================================================
          // キャンセル
          // =================================================

          if (
            expense.action ===
            'cancel_last'
          ) {
            const gasResponse =
              await fetch(
                GAS_URL,
                {
                  method: 'POST',

                  headers: {
                    'Content-Type':
                      'text/plain;charset=utf-8',
                  },

                  body: JSON.stringify({
                    action:
                      'cancel_last',
                  }),
                }
              );

            const gasResult =
              await gasResponse.json();

            console.log(
              'GAS cancel response:',
              gasResult
            );
          }

          // =================================================
          // 通常登録
          // =================================================

          else {
            const amount =
              Number(
                expense.amount
              );

            if (
              !Number.isFinite(
                amount
              )
            ) {
              throw new Error(
                `金額が数値ではありません: ${expense.amount}`
              );
            }

            const gasResponse =
              await fetch(
                GAS_URL,
                {
                  method: 'POST',

                  headers: {
                    'Content-Type':
                      'text/plain;charset=utf-8',
                  },

                  body: JSON.stringify({
                    action:
                      expense.action ||
                      'add',

                    person:
                      expense.person,

                    category:
                      expense.category,

                    amount:
                      amount,
                  }),
                }
              );

            const gasResult =
              await gasResponse.json();

            console.log(
              'GAS add response:',
              gasResult
            );
          }
        } catch (error) {
          console.error(
            '家計簿登録・キャンセルエラー:',
            error
          );
        }
      }
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
          msgs[
            msgs.length - 1
          ];

        if (
          last &&
          last.role ===
            'assistant'
        ) {
          msgs[
            msgs.length - 1
          ] = {
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

  // =======================================================
  // 通常入力
  // =======================================================

  const handleSubmit = async (
    e: FormEvent
  ) => {
    e.preventDefault();

    await sendMessage(input);
  };

  // =======================================================
  // AI回答を描画
  // =======================================================

  const renderAssistantContent = (
    content: string
  ) => {
    const lines = content.split('\n');

    return lines.map((line, index) => {
      // =================================================
      // AIが提示した選択肢
      //
      // 対応例：
      // - 「みどり、野菜1000円」
      // - みどり、野菜1000円
      // * 「友介、洗剤2980円」
      // 1. みどり、野菜1000円
      // 2) 友介、洗剤2980円
      // =================================================

      const choiceMatch = line.match(
        /^\s*(?:[-*•]|(?:\d+[\.\)]|[①②③④⑤⑥⑦⑧⑨⑩]))\s*(?:「(.+)」|(.+?))\s*$/
      );

      if (choiceMatch) {
        const command = (
          choiceMatch[1] ?? choiceMatch[2]
        ).trim();

        if (command) {
          return (
            <button
              key={index}
              type="button"
              className="suggestion-button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();

                // 選択肢そのものをエージェントへの回答として送信
                void sendMessage(command);
              }}
            >
              {command}
            </button>
          );
        }
      }

      // =================================================
      // 通常のAIテキスト
      // =================================================

      return (
        <div key={index}>
          <ReactMarkdown>
            {line}
          </ReactMarkdown>
        </div>
      );
    });
  };

  // =======================================================
  // UI
  // =======================================================

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

          {messages.map(
            (msg) => (
              <div
                key={msg.id}
                className={`message-row ${msg.role}`}
              >

                <div
                  className={`bubble ${msg.role}`}
                >

                  {/* =======================================
                      AI考え中
                  ======================================= */}

                  {msg.role ===
                    'assistant' &&
                    !msg.content &&
                    !msg.isToolUsing && (
                      <span className="thinking">
                        考え中…
                      </span>
                    )}

                  {/* =======================================
                      ツール使用中
                  ======================================= */}

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

                  {/* =======================================
                      AI回答
                  ======================================= */}

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
            )
          )}

          <div
            ref={
              messagesEndRef
            }
          />

        </div>
      </div>

      {/* ===================================================
          入力フォーム
      =================================================== */}

      <div className="form-wrapper">

        <form
          onSubmit={
            handleSubmit
          }
          className="form"
        >

          <input
            value={input}
            onChange={(e) =>
              setInput(
                e.target.value
              )
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
          {loading ? (
            '⌛️'
          ) : (
            <img
              src="/send-icon.png"
              alt="送信"
              className="send-icon"
            />
          )}
          </button>

        </form>

      </div>

    </div>
  );
}

export default App;
