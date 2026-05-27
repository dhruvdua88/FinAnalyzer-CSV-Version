from __future__ import annotations

from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
PDF_PATH = OUTPUT_DIR / "README_staff.pdf"


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="GuideTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=18,
            leading=22,
            textColor=colors.HexColor("#1f2937"),
            spaceAfter=10,
        )
    )
    styles.add(
        ParagraphStyle(
            name="GuideHeading",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=15,
            textColor=colors.HexColor("#0f172a"),
            spaceBefore=10,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="GuideBody",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            textColor=colors.HexColor("#334155"),
            spaceAfter=4,
        )
    )
    return styles


def bullet_list(items, style):
    return ListFlowable(
        [ListItem(Paragraph(item, style)) for item in items],
        bulletType="bullet",
        leftIndent=14,
        bulletFontName="Helvetica",
        bulletFontSize=9,
    )


def build_pdf() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    styles = build_styles()
    doc = SimpleDocTemplate(
        str(PDF_PATH),
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title="TSF Exporter Staff Guide",
        author="Codex",
    )

    story = [
        Paragraph("TSF Exporter Staff Guide", styles["GuideTitle"]),
        Paragraph(
            "This guide tells you exactly what to give staff and how they should use the exporter.",
            styles["GuideBody"],
        ),
        Spacer(1, 4),
        Paragraph("What To Give To Staff", styles["GuideHeading"]),
        Paragraph(
            "Do not send source-code folders from the main app. Share only the packaged exporter bundle.",
            styles["GuideBody"],
        ),
        bullet_list(
            [
                "<b>Recommended:</b> Give the full <b>dist/TSF Exporter/</b> folder as one zip.",
                "Keep these items together: <b>TSF Exporter.exe</b>, <b>vendor/</b>, <b>config/</b>, <b>README_staff.pdf</b>.",
                "Inside <b>vendor/</b>, keep <b>vendor/tally-loader/</b> and <b>vendor/node/</b> if the loader needs Node.",
            ],
            styles["GuideBody"],
        ),
        Paragraph("Do Not Give These Main-App Folders", styles["GuideHeading"]),
        bullet_list(
            [
                "<b>components/</b>",
                "<b>services/</b>",
                "<b>desktop-backend/</b>",
                "<b>dist/</b> from the main app",
                "<b>node_modules/</b>",
            ],
            styles["GuideBody"],
        ),
        Paragraph("How Staff Should Use It", styles["GuideHeading"]),
        bullet_list(
            [
                "Extract the zip to a normal folder on the computer.",
                "Open Tally and keep the correct company open.",
                "Double-click <b>TSF Exporter.exe</b>.",
                "Enter <b>From Date</b> and <b>To Date</b> in <b>dd/mm/yyyy</b> format.",
                "Choose the output folder if needed.",
                "Click <b>Run Export</b> and wait for the success message.",
                "Collect the generated file from the output folder.",
            ],
            styles["GuideBody"],
        ),
        Paragraph("Output File", styles["GuideHeading"]),
        bullet_list(
            [
                "<b>Tally_Source_File_yyyy-mm-dd.tsf</b>",
                "The exporter also creates a log file for troubleshooting.",
            ],
            styles["GuideBody"],
        ),
        Paragraph("Important Rules", styles["GuideHeading"]),
        bullet_list(
            [
                "Staff should not open or run anything inside <b>vendor/</b>.",
                "Staff should not run the private loader separately.",
                "If the bundle is moved, move the whole folder, not just the <b>.exe</b>.",
            ],
            styles["GuideBody"],
        ),
        Paragraph("If Something Fails", styles["GuideHeading"]),
        bullet_list(
            [
                "Check that Tally is open.",
                "Check that the correct company is open in Tally.",
                "Check that the selected output folder is writable.",
                "Check the log file created by the exporter.",
            ],
            styles["GuideBody"],
        ),
    ]

    doc.build(story)
    return PDF_PATH


if __name__ == "__main__":
    path = build_pdf()
    print(path)
