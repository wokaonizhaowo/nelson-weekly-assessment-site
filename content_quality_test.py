#!/usr/bin/env python3
"""Language-quality gate for Nelson's structured assessment content."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "Nelson晨读自动化" / "输出"
FILES = sorted(SOURCE.glob("Nelson英语晨读_WEEK_*_结构化数据.json"))


def contexts(payload: dict):
    for day in payload.get("days", []):
        for index, item in enumerate(day.get("contexts", []), 1):
            yield f"{payload.get('weekId')} D{day.get('day')} C{index}", item
    for index, item in enumerate(payload.get("assessmentQuestions", []), 1):
        yield f"{payload.get('weekId')} assessment {index}", item


def check_context(label: str, item: dict) -> list[str]:
    prompt = item.get("prompt", "")
    answer = item.get("answer", "")
    accepted = item.get("accepted", [])
    issues = []
    if not prompt or not answer:
        issues.append("缺少题干或答案")
    if re.search(r"[\u4e00-\u9fff]", re.sub(r"\([^)]*\)", "", prompt)):
        issues.append("英文语境题正文混入中文")
    if len(re.findall(r"[A-Za-z]_{3,}|_{3,}", prompt)) != 1:
        issues.append("填空数量不是 1")
    if accepted and answer not in accepted:
        issues.append("标准答案未包含在 accepted 中")

    lower = prompt.lower()
    answer_lower = answer.lower()
    exact_rules = [
        ("accidentally d_______", answer_lower == "dropped", "过去时应为 dropped"),
        ("take effective m_______", answer_lower == "measures", "固定搭配应为 take effective measures"),
        ("is s_______ for happiness", answer_lower == "struggling", "现在进行时应为 struggling"),
        ("my teacher i_______", answer_lower == "inspired", "明确过去时间后应为 inspired"),
        ("the school office i_______", answer_lower == "informed", "明确过去时间后应为 informed"),
        ("our e_______ control", answer_lower == "emotions", "与复数概念及原形谓语搭配应为 emotions"),
        ("if someone r_______", answer_lower == "reacts", "主将从现且 someone 为第三人称单数"),
        ("the school o_______", answer_lower == "offers", "一般现在时第三人称单数应为 offers"),
        ("the boy a_______", answer_lower == "admitted", "过去时应为 admitted"),
        ("parents are c_______", answer_lower == "concerned", "固定结构应为 be concerned about"),
        ("this project i_______", answer_lower == "involves", "一般现在时第三人称单数应为 involves"),
        ("ride b_______", answer_lower == "bicycles", "泛指自行车应使用复数 bicycles"),
        ("the teacher s_______", answer_lower == "suggests", "一般现在时第三人称单数应为 suggests"),
        ("should be fully u_______", answer_lower == "utilized", "被动语态应为 utilized"),
        ("good learning r_______", answer_lower == "resources", "可数名词泛指应为 resources"),
    ]
    for marker, valid, message in exact_rules:
        if marker in lower and not valid:
            issues.append(message)
    return [f"{label}: {issue} | {prompt} => {answer}" for issue in issues]


def main() -> None:
    if not FILES:
        raise SystemExit("未找到结构化晨读数据")
    issues = []
    for path in FILES:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for label, item in contexts(payload):
            issues.extend(check_context(label, item))
    if issues:
        raise SystemExit("内容审校失败：\n" + "\n".join(f"- {issue}" for issue in issues))
    print(f"Content quality checks passed for {len(FILES)} structured week files.")


if __name__ == "__main__":
    main()
