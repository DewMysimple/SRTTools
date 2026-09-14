import pytest

from srttools.subtitles import Cue, SubtitleError, clean_txt, format_time, parse_srt, parse_time, plain_text, render_srt, select_range


@pytest.mark.parametrize("value,expected", [("2", 2000), ("02:03", 123000), ("00:02:03,456", 123456),
    ("1.001", 1001), ("100:00:00.000", 360000000), ("120:00", 7200000)])
def test_times(value, expected):
    assert parse_time(value) == expected
    assert parse_time(format_time(expected)) == expected


@pytest.mark.parametrize("value", ["-1", "NaN", "inf", "1:60", "1:99:02", "2.0001", "", "1:2:3:4", "1.2:02"])
def test_invalid_times(value):
    with pytest.raises(SubtitleError):
        parse_time(value)


def test_srt_multilingual_settings_numeric_dialogue_roundtrip():
    text = "\ufeff9\r\n00:00:01.000 --> 00:00:03.000 X1:10 X2:20\r\n2026\r\n中文 English <i>你好</i>\r\n\r\n00:00:04,000 --> 00:00:05,000\r\n字幕"
    cues = parse_srt(text)
    assert cues[0] == Cue(1000, 3000, "2026\n中文 English <i>你好</i>", "X1:10 X2:20")
    assert parse_srt(render_srt(cues)) == cues
    assert render_srt(cues).startswith("1\n")


@pytest.mark.parametrize("text", ["", "1\nhello", "1\n00:00:01,000 --> 00:00:00,000\nhi",
    "1\n00:00:01,000 --> 00:00:02,000", "1\n00:00:00,000 --> 00:00:01,000\na\n2\n00:00:02,000 --> 00:00:03,000\nb",
    "00:00:01,000 --> 00:00:01,000\nzero"])
def test_malformed_srt_rejected(text):
    with pytest.raises(SubtitleError):
        parse_srt(text)


def test_cleanup_preserves_numeric_prose_and_orphan_text():
    text = "前言\n2026\n\n1\n00:00:01,000 --> 00:00:02,000\n42\n中文\n\n2\n00:00:03,000 --> 00:00:04,000\n结尾\n\n99"
    assert clean_txt(text) == "前言\n2026\n\n42\n中文\n\n结尾\n\n99"
    assert clean_txt("普通 TXT\n123\n没有时间轴") == "普通 TXT\n123\n没有时间轴"


def test_bad_txt_timing_fails_visibly():
    with pytest.raises(SubtitleError):
        clean_txt("1\n00:00:01 --> invalid\n正文")


def test_plain_text_choices_keep_unknown_tags():
    text = "<i>甲</i>\n乙\n\n<b>丙</b> &amp; <unknown>\n<br>丁"
    assert plain_text(text, strip_tags=True, layout="paragraph") == "甲 乙 丙 & <unknown> 丁\n"
    assert plain_text("甲\n乙\n\n丙", layout="lines") == "甲 乙\n丙\n"


@pytest.fixture
def cues():
    return [Cue(0, 2000, "before"), Cue(1500, 2500, "left"), Cue(2200, 2800, "inside"),
            Cue(2900, 4000, "right"), Cue(3000, 5000, "after")]


def test_range_overlap_half_open_clip_rebase(cues):
    selected = select_range(cues, 2000, 3000, rebase=True)
    assert selected == [Cue(0, 500, "left"), Cue(200, 800, "inside"), Cue(900, 1000, "right")]


def test_range_other_policies_offset(cues):
    assert select_range(cues, 2000, 3000, policy="contained") == [cues[2]]
    assert select_range(cues, 2000, 3000, policy="start", clip=False) == [cues[2], cues[3]]
    assert select_range(cues, 2000, 3000, policy="contained", offset=100)[0].start == 2300
    with pytest.raises(SubtitleError, match="负时间"):
        select_range(cues, 2000, 3000, clip=False, rebase=True)
    with pytest.raises(SubtitleError, match="没有匹配"):
        select_range(cues, 6000, 7000)
    with pytest.raises(SubtitleError):
        select_range(cues, 3000, 2000)
