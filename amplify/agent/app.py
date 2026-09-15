from strands import Agent
from strands_tools.rss import rss
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

def convert_event(event) -> dict | None:
"""Strandsのイベントをフロントエンド向けJSON形式に変換"""
try:
if not hasattr(event, 'get'):
return None

    inner_event = event.get('event')

    if not inner_event:
        return None

    content_block_delta = inner_event.get('contentBlockDelta')

    if content_block_delta:
        delta = content_block_delta.get('delta', {})
        text = delta.get('text')

        if text:
            return {
                'type': 'text',
                'data': text
            }

    content_block_start = inner_event.get('contentBlockStart')

    if content_block_start:
        start = content_block_start.get('start', {})

        tool_use = start.get('toolUse')

        if tool_use:
            tool_name = tool_use.get(
                'name',
                'unknown'
            )

            return {
                'type': 'tool_use',
                'tool_name': tool_name
            }

    return None

except Exception:
    return None

@app.entrypoint
async def invoke_agent(payload, context):

prompt = payload.get("prompt", "")

history = payload.get("history", [])

# =========================
# 会話履歴を文字列化
# =========================

conversation_text = ""

for message in history:
    role = message.get("role", "")
    content = message.get("content", "")

    if role == "user":
        conversation_text += f"ユーザー: {content}\n"

    elif role == "assistant":
        conversation_text += f"アシスタント: {content}\n"

system_prompt = """

あなたは家計簿アシスタントです。

ユーザーとの会話全体の文脈を考慮して回答してください。

=========================
家計簿登録
=====

ユーザーの発言から、家計簿に登録すべき情報を判断してください。

登録対象のカテゴリは以下の7種類だけです。

* 家賃
* 電気代
* ガス代
* 水道代
* 食費
* 日用品
* その他

人物は以下の2人です。

* 友介
* みどり

人物の呼び方には以下の別名があります。

* 「みどぴ」→「みどり」
* 「とも」→「友介」
* 「ともぴ」→「友介」

「みどぴ」「とも」「ともぴ」はGoogleスプレッドシートのpersonとして絶対に使用しないでください。

必ず、

* みどぴ → みどり
* とも → 友介
* ともぴ → 友介

に変換してください。

=========================
家計簿登録例
======

「みどぴ、野菜1000円」

→

person = みどり
category = 食費
amount = 1000

「みどりが洗剤を2980円買った」

→

person = みどり
category = 日用品
amount = 2980

「友介が野菜を1000円買った」

→

person = 友介
category = 食費
amount = 1000

家計簿として登録できる場合は、回答の最後に必ず以下を追加してください。

<EXPENSE>
{
  "person": "友介またはみどり",
  "category": "カテゴリ",
  "amount": 数値
}
</EXPENSE>

=========================
キャンセル処理
=======

キャンセルについては、単語だけで判断してはいけません。

必ず「ユーザーが何をキャンセルしようとしているのか」を会話全体から判断してください。

家計簿の「直前に登録した支出・取引」を取り消したい意図が明確な場合のみ、

<EXPENSE>
{
  "action": "cancel_last"
}
</EXPENSE>

を出力してください。

=========================
キャンセルとして扱う例
===========

「さっきの支出を取り消して」

「今登録したやつをキャンセルして」

「直前の取引を取り消して」

「さっき登録した1000円を取り消して」

「今の登録、間違えたから取り消して」

「やっぱりさっきのやつキャンセル」

これらは、直前の家計簿登録を指しているため、
cancel_lastを出力します。

=========================
キャンセルとして扱わない例
=============

「ともぴの飲み会がキャンセルになった」

「明日の飲み会がキャンセルになった」

「旅行がキャンセルになった」

「注文がキャンセルになった」

「この予定をキャンセルした」

「キャンセルってどういう意味？」

「キャンセル料はいくら？」

これらは家計簿取引のキャンセルではありません。

絶対にcancel_lastを出力しないでください。

=========================
重要な判断ルール
========

「キャンセル」「取り消し」「取消」という単語が含まれているだけでは、
家計簿取引のキャンセルとは判断しないでください。

以下の条件を満たす場合だけcancel_lastを出力してください。

1. 過去の会話に家計簿への登録が存在する
2. ユーザーがその登録を取り消したい意図を示している
3. 「飲み会」「旅行」「予定」「注文」など、
   家計簿登録とは別の対象をキャンセルしているだけではない

判断できない場合はcancel_lastを出力せず、
ユーザーに確認してください。

例えば、

「家計簿の直前の登録を取り消しますか？」

と確認してください。

=========================
会話文脈の扱い
=======

ユーザーの発言だけでは意味が分からない場合、
必ず会話履歴を確認してください。

例えば、

ユーザー:
「みどぴ、野菜1000円」

アシスタント:
「みどりが野菜を1000円買ったんだじょ」

ユーザー:
「やっぱキャンセル」

この場合、
「やっぱキャンセル」は直前の家計簿登録を指しているため、
cancel_lastを出力してください。

一方、

ユーザー:
「ともぴの飲み会がキャンセルになった」

だけの場合は、
家計簿取引のキャンセルとは判断しないでください。
"""

agent = Agent(
    model="jp.anthropic.claude-haiku-4-5-20251001-v1:0",
    system_prompt=system_prompt,
    tools=[rss]
)

# =========================
# AIへ会話履歴＋現在の発言を渡す
# =========================

full_prompt = f"""

以下はユーザーとの会話履歴です。

--- 会話履歴 ---
{conversation_text}
--- 会話履歴ここまで ---

現在のユーザー発言:
{prompt}

この発言に対して、会話全体の文脈を考慮して回答してください。
"""

async for event in agent.stream_async(full_prompt):

    converted = convert_event(event)

    if converted:
        yield converted

if **name** == "**main**":
app.run()
