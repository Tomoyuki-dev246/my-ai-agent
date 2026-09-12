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
                return {'type': 'text', 'data': text}

        content_block_start = inner_event.get('contentBlockStart')
        if content_block_start:
            start = content_block_start.get('start', {})
            tool_use = start.get('toolUse')
            if tool_use:
                tool_name = tool_use.get('name', 'unknown')
                return {'type': 'tool_use', 'tool_name': tool_name}

        return None

    except Exception:
        return None


@app.entrypoint
async def invoke_agent(payload, context):

    prompt = payload.get("prompt")

    system_prompt = """
あなたは家計簿アシスタントです。

ユーザーの発言から、家計簿に登録すべき情報を判断してください。

登録対象のカテゴリは以下の7種類だけです。

- 家賃
- 電気代
- ガス代
- 水道代
- 食費
- 日用品
- その他

ユーザーが支払った金額を読み取ってください。

人物は以下の2人です。

- 友介
- みどり

例えば、

「友介が野菜を1000円買った」

の場合は、

person = 友介
category = 食費
amount = 1000

です。

「みどりが洗剤を2980円買った」

の場合は、

person = みどり
category = 日用品
amount = 2980

です。

金額が書かれていない場合や、家計簿への登録ではない通常の質問の場合は、
無理に家計簿データを作らないでください。

通常の質問には普通に回答してください。

家計簿として登録できる場合は、回答の最後に必ず以下の形式を追加してください。

<EXPENSE>
{
  "person": "友介またはみどり",
  "category": "カテゴリ",
  "amount": 数値
}
</EXPENSE>
"""

    agent = Agent(
        model="jp.anthropic.claude-haiku-4-5-20251001-v1:0",
        system_prompt=system_prompt,
        tools=[rss]
    )

    async for event in agent.stream_async(prompt):
        converted = convert_event(event)

        if converted:
            yield converted


if __name__ == "__main__":
    app.run()