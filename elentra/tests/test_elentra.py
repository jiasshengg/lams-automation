"""Offline checks for the Elentra scripts. Run with: npm run test:elentra"""

import json
import os
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import kanban_reader
import settings
from playwright_resource_adder import build_title, resource_link_exists

LINK = "https://ilams.lamsinternational.com/lams/home/learner.do?lessonID=41170"


def patch_sheet_id(test):
    """Tests never depend on the machine's configured Kanban spreadsheet."""
    patcher = mock.patch.object(kanban_reader, "kanban_sheet_id", return_value="test-sheet")
    patcher.start()
    test.addCleanup(patcher.stop)


class FakeResponse:
    def __init__(self, payload=None, *, ok=True, status=200, url="https://ntu.elentra.cloud/admin/events?x", text=None):
        self._payload = payload
        self._text = text
        self.ok = ok
        self.status = status
        self.url = url

    def json(self):
        if self._text is not None:
            return json.loads(self._text)
        return self._payload


def fake_page(response):
    page = mock.Mock()
    page.request.get.return_value = response
    return page


class ResourceLinkExistsTest(unittest.TestCase):
    def test_finds_link_in_grouped_resource_list(self):
        payload = {"status": "success", "data": {"pre": [], "none": [[{"link": LINK}]]}}
        self.assertTrue(resource_link_exists(fake_page(FakeResponse(payload)), "42374", LINK))

    def test_missing_link_and_empty_event_are_not_found(self):
        other = {"status": "success", "data": {"none": [[{"link": "https://example.test"}]]}}
        self.assertFalse(resource_link_exists(fake_page(FakeResponse(other)), "42374", LINK))
        empty = {"status": "success", "data": []}
        self.assertFalse(resource_link_exists(fake_page(FakeResponse(empty)), "42374", LINK))

    def test_unreadable_responses_fail_closed_instead_of_allowing_a_duplicate(self):
        cases = [
            FakeResponse(text="<html>login</html>"),
            FakeResponse({"status": "error", "data": "denied"}),
            FakeResponse({"status": "success", "data": "unexpected"}),
            FakeResponse({}, ok=False, status=500),
            FakeResponse({}, url="https://ntu.elentra.cloud/?url=%2Fadmin%2Fevents"),
        ]
        for response in cases:
            with self.subTest(response=response.__dict__):
                with self.assertRaises(RuntimeError):
                    resource_link_exists(fake_page(response), "42374", LINK)


class TitleTest(unittest.TestCase):
    def test_link_titles(self):
        self.assertEqual(build_title("MSK - TBL 1", "learner"), "LAMS MSK - TBL 1")
        self.assertEqual(build_title("MSK - TBL 1", "monitoring"), "LAMS MSK - TBL 1 (Facilitator/CE)")

    def test_second_line_of_details_wins_and_empty_module_is_not_nan(self):
        row = {"Module": "", "TBL/Quiz Details": "Old title\nReal title"}
        self.assertEqual(kanban_reader._build_title(row), "Real title")
        row = {"Module": math.nan, "TBL/Quiz Details": "TBL 1"}
        self.assertEqual(kanban_reader._build_title(row), "TBL 1")
        row = {"Module": "Skin (SKIN)", "TBL/Quiz Details": "TBL 1"}
        self.assertEqual(kanban_reader._build_title(row), "Skin (SKIN) - TBL 1")


SHEET_CSV = (
    "w,Module,TBL/Quiz Details,Lesson ID,Elentra Event ID,w\n"
    "Wk29,,,,,\n"
    "Can start,Skin (SKIN),\"TBL 1\nSkin TBL 1 real\",41174,27662,ignored\n"
    " can START ,MSK,TBL 2,,27323.0,\n"
    "Done,MSK,TBL 3,41175,27324,\n"
    "Can start,MSK,TBL 4,N/A,27325,\n"
)


class KanbanReaderTest(unittest.TestCase):
    def setUp(self):
        patch_sheet_id(self)
        response = mock.Mock(content=SHEET_CSV.encode("utf-8"))
        patcher = mock.patch.object(kanban_reader.requests, "get", return_value=response)
        patcher.start()
        self.addCleanup(patcher.stop)
        tabs = mock.patch.object(kanban_reader, "resolve_tab", return_value=("Tab", "1"))
        tabs.start()
        self.addCleanup(tabs.stop)

    def test_fetch_step_needs_can_start_and_an_event_id(self):
        lessons = kanban_reader.get_ready_lessons("Tab")
        self.assertEqual([l["id"] for l in lessons], ["27662", "27323", "27325"])
        self.assertEqual(lessons[0]["title"], "Skin (SKIN) - Skin TBL 1 real")
        self.assertEqual(lessons[0]["row"], 1)

    def test_links_step_also_needs_a_numeric_lesson_id(self):
        lessons = kanban_reader.get_resource_ready_lessons("Tab")
        self.assertEqual(len(lessons), 1)
        self.assertEqual(lessons[0]["lesson_id"], "41174")
        self.assertEqual(lessons[0]["learner_link"], kanban_reader.LEARNER_LINK_BASE + "41174")

    def test_rows_are_described_with_their_sheet_row_and_lesson_title(self):
        rows = kanban_reader.list_rows("Tab")
        self.assertEqual([row["sheet_row"] for row in rows], [3, 4, 6])
        self.assertEqual(rows[0]["session"], "TBL 1")
        self.assertEqual(rows[0]["lesson_title"], "Skin TBL 1 real")
        self.assertIsNone(rows[1]["lesson_id"])
        # Week dividers ("Wk29") have no TBL/Quiz Details and are not rows to run.
        self.assertEqual(len(kanban_reader.list_rows("Tab", ready_only=False)), 4)

    def test_rows_are_found_by_details_as_whole_words(self):
        self.assertEqual([r["sheet_row"] for r in kanban_reader.find_rows("Tab", "skin tbl 1 REAL")], [3])
        self.assertEqual([r["sheet_row"] for r in kanban_reader.find_rows("Tab", "TBL 2")], [4])
        self.assertEqual(kanban_reader.find_rows("Tab", "TBL"), kanban_reader.find_rows("Tab", " tbl "))
        self.assertEqual(kanban_reader.find_rows("Tab", "TBL 20"), [])
        # "TBL 1" must not also match "TBL 10".
        with mock.patch.object(kanban_reader.requests, "get", return_value=mock.Mock(content=b"w,TBL/Quiz Details,Lesson ID,Elentra Event ID\nCan start,TBL 1 a,,1\nCan start,TBL 10 b,,2\n")):
            self.assertEqual([r["event_id"] for r in kanban_reader.find_rows("Tab", "TBL 1")], ["1"])


HTMLVIEW = (
    'items.push({name: "Kanban AY26\\/27", pageUrl: "https:\\/\\/docs\\/htmlview\\/sheet?headers\\x3dtrue&gid=111"});'
    'items.push({name: "DONOTUSE_Kanban AY25\\/26", pageUrl: "https:\\/\\/docs\\/sheet?headers\\x3dtrue&gid=222"});'
    'items.push({name: "Process \\x26 QC", pageUrl: "https:\\/\\/docs\\/sheet?gid=333"});'
)


class TabTest(unittest.TestCase):
    def setUp(self):
        patch_sheet_id(self)
        patcher = mock.patch.object(kanban_reader.requests, "get", return_value=mock.Mock(text=HTMLVIEW))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_tab_names_and_gids_come_from_the_sheet(self):
        self.assertEqual(kanban_reader.list_tabs(), [
            ("Kanban AY26/27", "111"), ("DONOTUSE_Kanban AY25/26", "222"), ("Process & QC", "333"),
        ])

    def test_exact_name_wins_then_a_unique_partial_name(self):
        self.assertEqual(kanban_reader.resolve_tab(" kanban  ay26/27 "), ("Kanban AY26/27", "111"))
        self.assertEqual(kanban_reader.resolve_tab("DONOTUSE"), ("DONOTUSE_Kanban AY25/26", "222"))
        # A space typed for the underscore still names the tab exactly.
        self.assertEqual(kanban_reader.resolve_tab("donotuse kanban AY25/26"), ("DONOTUSE_Kanban AY25/26", "222"))

    def test_missing_or_ambiguous_tab_names_list_the_choices(self):
        with self.assertRaisesRegex(kanban_reader.KanbanError, "several tabs.*Kanban AY26/27.*DONOTUSE"):
            kanban_reader.resolve_tab("Kanban")
        with self.assertRaisesRegex(kanban_reader.KanbanError, "no tab"):
            kanban_reader.resolve_tab("AY99")
        with self.assertRaises(kanban_reader.KanbanError):
            kanban_reader.resolve_tab("  ")


class SettingsTest(unittest.TestCase):
    def test_session_and_downloads_stay_in_ignored_folders(self):
        self.assertEqual(settings.AUTH_STATE_PATH, settings.REPO_ROOT / ".playwright" / "elentra-auth.json")
        if not os.environ.get("DOWNLOAD_DIR"):
            self.assertEqual(settings.DOWNLOAD_DIR, settings.REPO_ROOT / "sot-docs")
        ignored = (settings.REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("sot-docs/", ignored)

    def test_browser_channel_follows_local_config(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "local.json"
            with mock.patch.object(settings, "LOCAL_CONFIG_PATH", config):
                self.assertEqual(settings.launch_options(True), {"headless": True})
                config.write_text('{"browser": {"channel": "msedge"}}', encoding="utf-8")
                self.assertEqual(settings.launch_options(False), {"headless": False, "channel": "msedge"})
                config.write_text('{"browser": {"channel": " "}}', encoding="utf-8")
                self.assertIsNone(settings.browser_channel())

    def test_kanban_sheet_id_comes_from_local_config(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "local.json"
            with mock.patch.object(settings, "LOCAL_CONFIG_PATH", config), \
                    mock.patch.dict(os.environ, {"KANBAN_SHEET_ID": ""}):
                with self.assertRaises(RuntimeError):
                    settings.kanban_sheet_id()
                config.write_text('{"sheet": {"spreadsheetId": " abc123 "}}', encoding="utf-8")
                self.assertEqual(settings.kanban_sheet_id(), "abc123")
                with mock.patch.dict(os.environ, {"KANBAN_SHEET_ID": "override"}):
                    self.assertEqual(settings.kanban_sheet_id(), "override")


if __name__ == "__main__":
    unittest.main()


class DownloadManifestTest(unittest.TestCase):
    def test_resource_titles_are_classified_as_irat_or_ae(self):
        import main
        self.assertEqual(main.sot_kind("AY2627 FOM TBL 11 iRA Faculty QA"), "irat")
        self.assertEqual(main.sot_kind("AY2627 FOM TBL 11 AE Faculty QA"), "ae")
        self.assertEqual(main.sot_kind("iRA and AE QA"), "unknown")
        self.assertEqual(main.sot_kind("Faculty QA"), "unknown")

    def test_an_event_counts_as_downloaded_only_when_every_listed_file_exists(self):
        import main
        with tempfile.TemporaryDirectory() as folder:
            lesson_dir = Path(folder)
            self.assertIsNone(main.read_manifest(lesson_dir))  # files but no manifest: download again
            (lesson_dir / "a.docx").write_bytes(b"x")
            manifest = {"eventId": "1", "files": [{"filename": "a.docx"}, {"filename": "b.docx"}]}
            (lesson_dir / "sources.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertIsNone(main.read_manifest(lesson_dir))  # b.docx missing: a partial download
            (lesson_dir / "b.docx").write_bytes(b"x")
            self.assertEqual(main.read_manifest(lesson_dir), manifest)

    def test_recorded_paths_are_repository_relative_with_forward_slashes(self):
        import main
        self.assertEqual(main._relative(settings.REPO_ROOT / "sot-docs" / "27337" / "a.docx"), "sot-docs/27337/a.docx")
