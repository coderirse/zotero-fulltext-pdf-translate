# Side-by-side bilingual PDF merger (doc2x-style layout).
# Runs on the Python runtime bundled with the pdf2zh v1 engine:
#   python.exe side_by_side.py <original.pdf> <translated.pdf> <out.pdf> <site-packages>
# The bundled runtime uses an isolated ._pth, so site-packages is passed
# explicitly instead of relying on PYTHONPATH.

import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 5:
        print(
            "usage: side_by_side.py <original.pdf> <translated.pdf> <out.pdf> <site-packages>"
        )
        return 2
    orig_path, trans_path, out_path, site_packages = sys.argv[1:5]
    if site_packages and Path(site_packages).is_dir():
        sys.path.insert(0, site_packages)
    try:
        import fitz  # PyMuPDF, bundled with the pdf2zh engine runtime
    except ImportError as e:
        print(f"fitz import failed: {e}")
        return 3

    doc_orig = fitz.open(orig_path)
    doc_trans = fitz.open(trans_path)
    out = fitz.open()
    n = min(len(doc_orig), len(doc_trans))
    for i in range(n):
        po = doc_orig[i]
        pt = doc_trans[i]
        r = po.rect
        gap = r.width / 100.0
        width = r.width * 2 + gap
        height = r.height
        page = out.new_page(width=width, height=height)
        page.show_pdf_page(fitz.Rect(0, 0, r.width, r.height), doc_orig, i)
        page.show_pdf_page(
            fitz.Rect(r.width + gap, 0, r.width * 2 + gap, r.height), doc_trans, i
        )
    out.save(out_path, garbage=3, deflate=True)
    out.close()
    doc_trans.close()
    doc_orig.close()
    print(f"saved: {out_path} pages={n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
