# Nelson 周测与月考 H5

移动端静态 MVP，用于验证周测、月考、成绩趋势、错题档案和家长复习建议。

## 本地运行

```bash
cd "Nelson英语成长/weekly-assessment"
python3 -m http.server 4173
```

浏览器打开 `http://localhost:4173`。

## 已实现

- 25 题周测：13 道刚结束一周、7 道前一周、5 道历史错题，每题 4 分。
- 40 题月考：16 道当月错题、14 道重点单词、10 道重点语法，每题 2.5 分。
- 整卷提交后统一评分，答题中途使用 `localStorage` 自动恢复。
- 只累计页面位于前台时的有效考试时间，退出或切到后台自动暂停。
- 题号导航显示当前题、已答题和未答题，并允许返回已答题修改。
- 正式成绩首次提交后锁定；再次进入只能查看成绩或发起不计分重做。
- 错题查看答案后必须隐藏答案重新答对，才可完成本次订正。
- 每道订正题显示完整中文句意；订正可中途退出，首页持续提示剩余题数。
- 周测和月考独立成绩趋势、分项得分和历史记录。
- 知识点级错误次数、错误率、近期连续错误、月考错误及连续答对降权。
- 家长复习建议附带证据、典型错误和具体训练动作。
- 家长可调节优先级，并把知识点加入下周试卷草稿。
- 每日单词地图包含认识、辨认、拼写、语境和终极挑战，约 10 个词。
- 晨读词按学习日开放，拼写与用法必须跨日答对才算真正掌握。
- 背词错项会进入后续周测候选和下一周晨读巩固队列。
- 家长只需输入英文单词，AI 自动补齐并审校学习卡，确认后才会启用。

## Supabase 云端同步

网页使用 Supabase Auth 登录，并把 Nelson 与家长账号的数据同步到同一个家庭空间。

1. 在 Supabase Dashboard 打开项目。
2. 在 `SQL Editor` 运行 `supabase-setup.sql`。
3. 在 `Authentication > Users` 创建两个用户：
   - `nelson@nelson-study.app`
   - `parent@nelson-study.app`
4. 分别设置 Nelson 密码和家长密码。
5. 在 Authentication 设置中关闭公开注册，只保留手动创建的用户。

网页只要求选择身份并输入密码。公开仓库中只保存 publishable key，不保存密码、数据库密码或 service role key。

同步内容包括成绩、逐题答案、错题订正、掌握档案、家长优先级调整和下周试卷草稿。本地存储仍保留缓存，答题中断时先保存在设备上，恢复页面后再同步。

错题还会进入 `morningReviewQueue`。晨读自动化可在生成新一周材料前运行：

```bash
export NELSON_STUDENT_PASSWORD='Nelson 的当前密码'
python3 "../../Nelson晨读自动化/模板/fetch_assessment_review.py"
```

脚本会生成 `Nelson晨读自动化/输出/下周晨读复习重点.json`。密码只从环境变量读取，不写入代码或输出文件。

运行引擎测试：

```bash
node engine.test.js
node vocabulary-engine.test.js
python3 content_quality_test.py
```

家长自动生成学习卡还需要部署 Supabase Edge Function，步骤见
`SUPABASE-VOCABULARY-SETUP.md`。

## 与晨读自动化联动

晨读自动化每周输出：

`Nelson晨读自动化/输出/Nelson英语晨读_WEEK_XX_结构化数据.json`

同步脚本读取输出目录中最新两周内容，并生成浏览器可直接加载的
`morning-reading-data.js`：

```bash
cd "Nelson英语成长/weekly-assessment"
python3 sync_morning_reading.py
```

周测的 13 道新近题来自最新一周晨读，7 道巩固题来自前一周晨读，另外 5 道来自历史错题。
晨读生成脚本完成 DOCX/PDF/JSON 后会自动调用同步脚本，因此正常自动化运行时无需手动执行。
