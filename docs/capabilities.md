# Flow UI capabilities (live discovery, 2026-10-01)

Source for every fact: read-only DOM probe over CDP of the dedicated Chrome, inside project
`https://flow.google.com/project/e0ea29e6-…`, UI language Vietnamese. No generation was submitted
during discovery. `config/capabilities.json` holds the machine-readable subset; `null` there means
"not observed", never a guess.

## Environment changes that break the current automation

| Fact | Evidence | Impact |
| --- | --- | --- |
| Flow moved from `labs.google/fx/tools/flow` to `https://flow.google.com/` | navigating to the old URL lands on `https://flow.google.com/`; projects are `flow.google.com/project/<uuid>` | `PlaywrightFlowDriver.#connect` checks `url.includes('labs.google')`, so it re-navigates before every job and leaves the project; `createNewProject` builds card links with `https://labs.google`; `redownload` and the handlers download from `labs.google/fx/api/trpc/media.getMediaUrlRedirect` — all need re-checking on the new domain |
| UI language follows the Google account: Vietnamese | all labels, e.g. send button `aria-label="Bắt đầu tạo"` | handlers match Italian/French/English text (`Approva`, `Accepter`, `Nuovo progetto`) — use aria-labels/icons instead of words |
| Signed-in account differs from `expectedAccount` in `config/flow.config.json` | account chip `aria-label="Tài khoản Google: <name> (<email>) …"` | `verifyAccount()` returns the configured `expectedAccount` without reading the page (`method: 'assumed'`), so `/health.accountMatches` is always true — must read the chip's aria-label |
| Region requires a visible watermark | account menu: "Khu vực của bạn yêu cầu phải có hình mờ có thể nhìn thấy" | every generated image/video carries a visible watermark |
| Credit balance shown in the account menu | "1.050 tín dụng Google Flow" | credit cost per model can be measured by reading the balance before/after a job |

## Project creation bug (root cause of the Task 12 failure)

`createNewProject` looks for a project-name input with a list ending in `'[contenteditable="true"]'`.
In the current UI a new project has no name dialog; that selector matches the **agent chat box**, so
the project name (`daemon-smoke`) was typed and submitted as a chat message. The agent generated an
image from it, the send button turned into a stop button, and the real job failed with
`Generate button not found`. Projects are named by an editable title input at the top-left
(`aria-label="Văn bản có thể chỉnh sửa"`, default value like `Tháng 10 01 - 02:56`).
Also, the stored project entry never records `campaign`, so campaign reuse never matches.

## Prompt bar (right-hand agent panel)

| Control | aria-label | Icon text |
| --- | --- | --- |
| Add ingredient | `Thêm thành phần vào ô nhập câu lệnh` | `add` (becomes `close` while open) |
| Agent instructions | `Chỉ dẫn cho tác nhân` | `article_spark` |
| Settings | `Cài đặt` | `tune` |
| Send | `Bắt đầu tạo` | `arrow_forward` (shows a stop square while the agent is busy) |
| Clear prompt | `Xoá câu lệnh` | `close` |
| New session | `Bắt đầu phiên mới` | `edit_square` |

## Settings panel (`Cài đặt`) — this is where model and ratio are selected

Opened as a side panel with `Quay lại` (back) and `Lưu` (save). Closing without `Lưu` discards changes.

- **Confirm before generating** (`Xác nhận trước khi tạo`): `Luôn luôn` (agent asks for confirmation
  before generating) / `Không bao giờ` (agent generates automatically and deducts credits). Two
  radio inputs.
- **Image defaults** (`Chế độ mặc định của tính năng tạo hình ảnh`): ratios 16:9, 4:3, 1:1, 3:4, 9:16;
  count x1–x4; model menu (`aria-label="Mô hình mặc định của quá trình tạo hình ảnh"`) with
  `🍌 Nano Banana Pro`, `🍌 Nano Banana 2`, `🍌 Nano Banana 2 Lite`. **Imagen 4 is gone.**
- **Video defaults** (`Chế độ mặc định của tính năng tạo video`): ratios 16:9, 9:16; count x1–x4;
  model menu (`aria-label="Mô hình mặc định của tính năng tạo video"`) with `Omni 1.1 Flash`,
  `Veo 3.1 - Lite`, `Veo 3.1 - Fast`, `Veo 3.1 - Quality`.
- There is **no duration control**; duration can only be requested in the prompt text.
- Menus are Angular CDK overlays; while one is open a `.cdk-overlay-backdrop` intercepts clicks and
  must be dismissed (click the backdrop) before other controls respond. `Escape` was unreliable.

## Ingredient picker (`+`)

Tabs: `Tất cả`, `Hình ảnh`, `Video`, `Giọng nói` (voice), `Nhân vật` (characters), `Hình đại diện`
(avatars), `Tệp tải lên` (uploads); button `Tải nội dung nghe nhìn lên` (upload media); a search box;
a "Recent" list of project media; confirm button `Thêm vào câu lệnh` (add to prompt). No
`<input type=file>` exists until upload is triggered. Reference images are therefore attached as
prompt ingredients; how the agent maps an ingredient to first frame / last frame / reference is
driven by the prompt text and still needs one live test per mode.

## Agent instructions (`Chỉ dẫn cho tác nhân`)

Side panel with `Thêm hướng dẫn` (add instruction) and `Xong` (done): persistent instructions for the
agent. A standing instruction such as "generate immediately, never ask clarifying questions" can
replace the Italian wrapper the handlers prepend to every prompt.

## Not observed (null in capabilities.json)

Per-model credit cost, allowed video durations, maximum ingredients, frame/ingredient modes per
video model, download resolutions, and the texts Flow shows for content refusal, missing credits
and clarification questions. Measuring these requires generations and belongs to Plan A2.

## Live results (Plan A2, 2026-10-01)

| Check | Result |
| --- | --- |
| Nano Banana 2, 1:1, x1, text only | JPEG 1024×1024 from the signed `flow-content.google/image/…` URL, visible sparkle watermark bottom-right, one new image in the project |
| Credit cost, Nano Banana 2 | 0 (balance 1.050 before and after; the stray 16:9 image earlier also cost 0) |
| New project | the fixed `add` ("Dự án mới") button on the home page creates a project; `Start Creating` only reopens the most recent project |
| Send button | stays disabled for a moment after text is inserted; wait for it to enable |
| Account panel | `role="dialog"` without a backdrop; closes through its own `close` icon |
