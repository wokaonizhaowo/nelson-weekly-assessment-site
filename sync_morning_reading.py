#!/usr/bin/env python3
"""Build the web assessment bank from the latest morning-reading JSON exports."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / "Nelson晨读自动化" / "输出"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "morning-reading-data.js"


def week_number(path: Path) -> int:
    match = re.search(r"WEEK_(\d+)_结构化数据\.json$", path.name)
    return int(match.group(1)) if match else -1


def load_weeks(source: Path, latest_week: int | None = None) -> list[dict]:
    files = sorted(
        source.glob("Nelson英语晨读_WEEK_*_结构化数据.json"),
        key=week_number,
        reverse=True,
    )
    if latest_week is not None:
        files = [path for path in files if week_number(path) <= latest_week]
    return [json.loads(path.read_text(encoding="utf-8")) for path in files[:2]]


def clean_prompt(prompt: str) -> str:
    return re.sub(r"\s*\([^)]*[\u4e00-\u9fff][^)]*\)", "", prompt).strip()


def chinese_hint(prompt: str, fallback: str) -> str:
    match = re.search(r"\(([^)]*[\u4e00-\u9fff][^)]*)\)", prompt)
    return match.group(1) if match else fallback


def build_context_question(
    context: dict,
    word: dict,
    week: dict,
    day: dict,
    scope: str,
    index: int,
) -> dict:
    answer = context["answer"]
    source_week = week.get("weekId", week.get("label", "unknown"))
    source_day = day.get("day")
    translation = context.get("translation") or (
        f"本句来自 {week.get('label', source_week)} Day {source_day}，"
        f"考查「{answer}（{word.get('meaning', answer)}）」的语境用法。"
    )
    return {
        "id": f"{source_week}-day{source_day}-context{index}",
        "knowledgeId": f"word:{answer.lower()}",
        "knowledge": answer,
        "prompt": clean_prompt(context["prompt"]),
        "instruction": f"根据中文提示「{chinese_hint(context['prompt'], word.get('meaning', answer))}」补全单词。",
        "type": "input",
        "kind": "句中拼写",
        "category": context.get("category", "spelling"),
        "scope": scope,
        "answer": answer,
        "accepted": context.get("accepted", [answer]),
        "errorType": context.get("errorType", "spelling"),
        "importance": context.get("importance", 4),
        "explanation": context.get(
            "explanation",
            f"正确答案是 {answer}。{word.get('insight', '注意它在句中的拼写和用法。')}",
        ),
        "translation": translation,
        "variantPrompt": context.get("variantPrompt", clean_prompt(context["prompt"])),
        "sourceWeek": source_week,
        "sourceDay": source_day,
        "sourceTitle": day.get("title", ""),
        "sourceGrammar": day.get("grammar", ""),
    }


def build_questions(week: dict, scope: str) -> list[dict]:
    questions = []
    for index, question in enumerate(week.get("assessmentQuestions", []), 1):
        item = dict(question)
        item.setdefault("id", f"{week.get('weekId')}-assessment-{index}")
        item.setdefault("scope", scope)
        item.setdefault("sourceWeek", week.get("weekId"))
        questions.append(item)

    for day in week.get("days", []):
        words = {item["word"].lower(): item for item in day.get("words", [])}
        for index, context in enumerate(day.get("contexts", []), 1):
            questions.append(
                build_context_question(
                    context,
                    words.get(context["answer"].lower(), {}),
                    week,
                    day,
                    scope,
                    index,
                )
            )
    return questions


def build_payload(weeks: list[dict]) -> dict:
    if not weeks:
        raise SystemExit("No structured morning-reading JSON files found.")
    latest = weeks[0]
    previous = weeks[1] if len(weeks) > 1 else None
    questions = build_questions(latest, "recent")
    if previous:
        questions.extend(build_questions(previous, "previous"))
    else:
        questions.extend(
            {
                **question,
                "id": f"{question['id']}-previous-fallback",
                "scope": "previous",
                "fallbackFromLatestWeek": True,
            }
            for question in build_questions(latest, "recent")
        )
    return {
        "latestWeek": latest.get("weekId"),
        "latestLabel": latest.get("label"),
        "latestDateRange": f"{latest.get('startDate')} 至 {latest.get('endDate')}",
        "previousWeek": previous.get("weekId") if previous else None,
        "questions": questions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--latest-week", type=int)
    args = parser.parse_args()
    payload = build_payload(load_weeks(args.source, args.latest_week))
    args.output.write_text(
        "(function (root) {\n"
        f"  root.NELSON_MORNING_READING_DATA = {json.dumps(payload, ensure_ascii=False, indent=2)};\n"
        "})(typeof window !== \"undefined\" ? window : globalThis);\n",
        encoding="utf-8",
    )
    recent = sum(item["scope"] == "recent" for item in payload["questions"])
    previous = sum(item["scope"] == "previous" for item in payload["questions"])
    print(
        f"Synced {payload['latestWeek']}: {recent} latest-week questions, "
        f"{previous} previous-week questions -> {args.output}"
    )


if __name__ == "__main__":
    main()
