// 必要なパッケージをインポート
import { useState, useRef, useEffect, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ReactMarkdown from 'react-markdown';
import './App.css';
import outputs from '../amplify_outputs.json';

// Amplify outputs から設定を取得
const AGENT_ARN = outputs.custom?.agentRuntimeArn;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzwCOqbjwUkbry-Y5KLENR_8I8iQeNrkBVgJx-ec6RV04K4fihEEWAB1SE8PIDLn2MTiA/exec';

// チャットメッセージの型定義
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isToolUsing?: boolean;
  toolCompleted?: boolean;
  toolName?: string;
}

// メインのアプリケーションコンポーネント
function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // メッセージ追加時に自動スクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // フォーム送信処理
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    // ユーザーメッセージを作成
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
    };

    // =========================
    // 通常のAIチャット処理
    // =========================

    // メッセージ配列に追加（ユーザー発言 + 空のAI応答）
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

    // Cognito認証トークンを取得
    const session = await fetchAuthSession();
    const accessToken = session.tokens?.accessToken?.toString();

    // AgentCore Runtime APIを呼び出し
    const url = `https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: userMessage.content }),
    });

    // SSEストリーミングを処理
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isInToolUse = false;
    let toolIdx = -1;

    // ストリームを読み続ける
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 受信データを行ごとに処理
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        const event = JSON.parse(data);

        // ツール使用開始イベント
        if (event.type === 'tool_use') {
          isInToolUse = true;
          const savedBuffer = buffer;
          setMessages(prev => {
            const msgs = [...prev];
            if (savedBuffer) {
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: savedBuffer };
              toolIdx = msgs.length;
              msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: '', isToolUsing: true, toolName: event.tool_name });
            } else {
              toolIdx = msgs.length - 1;
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], isToolUsing: true, toolName: event.tool_name };
            }
            return msgs;
          });
          buffer = '';
          continue;
        }

        // テキストイベント（AI応答本文）
        if (event.type === 'text' && event.data) {
          if (isInToolUse && !buffer) {
            // ツール実行後の最初のテキスト → ツールを完了状態に
            const savedIdx = toolIdx;
            setMessages(prev => {
              const msgs = [...prev];
              if (savedIdx >= 0 && savedIdx < msgs.length) msgs[savedIdx] = { ...msgs[savedIdx], toolCompleted: true };
              msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: event.data });
              return msgs;
            });
            buffer = event.data;
            isInToolUse = false;
            toolIdx = -1;
          } else {
            // 通常のテキスト蓄積（ストリーミング表示）
            buffer += event.data;

            // 家計簿用のJSON部分を画面には表示しない
            const displayText = buffer.replace(
              /<EXPENSE>[\s\S]*?<\/EXPENSE>/g,
              ''
            ).trim();

            setMessages(prev => {
              const msgs = [...prev];

              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: displayText,
                isToolUsing: false
              };

              return msgs;
            });
          }
        }
      }
    }
    // AIが返した家計簿データを取得
    const expenseMatch = buffer.match(
      /<EXPENSE>\s*(\{[\s\S]*?\})\s*<\/EXPENSE>/
    );

    if (expenseMatch) {
      try {
        const expense = JSON.parse(expenseMatch[1]);

        await fetch(GAS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8',
          },
          body: JSON.stringify({
            action: expense.action || "add",
            person: expense.person,
            category: expense.category,
            amount: expense.amount,
          }),
        });
      } catch (error) {
        console.error('家計簿登録エラー:', error);
      }
    }
    // AIの返答の最後に「だじょ」を付ける
    setMessages(prev => {
      const msgs = [...prev];
      const last = msgs[msgs.length - 1];

      if (last && last.role === 'assistant' && last.content) {
        msgs[msgs.length - 1] = {
          ...last,
          content: last.content + 'だじょ'
        };
      }

      return msgs;
    });
    setLoading(false);
  };

  // チャットUI（ヘッダー＋チャットエリア＋入力フォーム）
  return (
    <div className="container">
      <header className="header">
        <h1 className="title">家計簿編集エージェントアプリ</h1>
        <p className="subtitle">みどぴ使うんだじょ</p>
      </header>

      <div className={`message-area ${messages.length === 0 ? 'empty' : ''}`}>
        <div className="message-container">
          {messages.map(msg => (
            <div key={msg.id} className={`message-row ${msg.role}`}>
              <div className={`bubble ${msg.role}`}>
                {msg.role === 'assistant' && !msg.content && !msg.isToolUsing && (
                  <span className="thinking">考え中…</span>
                )}
                {msg.isToolUsing && (
                  <span className={`tool-status ${msg.toolCompleted ? 'completed' : 'active'}`}>
                    {msg.toolCompleted ? '✓' : '⏳'} {msg.toolName}
                    {msg.toolCompleted ? 'ツールを利用しました' : 'ツールを利用中...'}
                  </span>
                )}
                {msg.content && !msg.isToolUsing && <ReactMarkdown>{msg.content}</ReactMarkdown>}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="form-wrapper">
        <form onSubmit={handleSubmit} className="form">
          <input value={input} onChange={e => setInput(e.target.value)} placeholder="メッセージを入力..." disabled={loading} className="input" />
          <button type="submit" disabled={loading || !input.trim()} className="button">
            {loading ? '⌛️' : '送信'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
