#!/usr/bin/env python3
"""Offline evidence, NOT professional-design acceptance.

Render an unchanged DOCX and one-variable diagnostic copies through any supplied
LibreOffice executables. No package downloads, model calls, production writes or
source edits. Counterfactual files are explicitly separated from final artifacts.
Usage: --docx PATH --metadata PATH --office NAME=/path/soffice (repeat) --output DIR
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
X = 'http://www.w3.org/1999/xhtml'
S = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0'
F = 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'
T = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(args: list[str]) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stdout[-1200:]} {result.stderr[-1200:]}')
    return result.stdout


def page_constraint(required: int | None, observed: int) -> str:
    if required is None:
        return 'NOT_REQUESTED'
    if not isinstance(required, int) or isinstance(required, bool) or required < 1:
        raise ValueError('Invalid explicit page requirement')
    return 'PASS' if observed == required else 'FAIL'


def parity(counts: list[int]) -> str:
    # Independent requirement: lack of an explicit cap never converts a
    # cross-render mismatch to a parity PASS.
    return 'PASS' if len(counts) > 1 and len(set(counts)) == 1 else 'PENDING' if len(counts) < 2 else 'FAIL'


def glyphs(text: str) -> str:
    text = unicodedata.normalize('NFKC', text)
    return re.sub(r'\s+', '', text.replace('•', '').replace('●', '').translate(str.maketrans('‘’“”', "''\"\"")))


def geometry(pdf: Path) -> dict:
    root = ET.fromstring(run(['pdftotext', '-bbox-layout', str(pdf), '-']))
    pages = []
    for index, page in enumerate(root.iter(f'{{{X}}}page'), 1):
        lines = []
        for line in page.iter(f'{{{X}}}line'):
            words = list(line.iter(f'{{{X}}}word'))
            lines.append({'text': ' '.join(w.text or '' for w in words),
                          'x0': float(line.attrib['xMin']), 'x1': float(line.attrib['xMax']),
                          'y0': float(line.attrib['yMin']), 'y1': float(line.attrib['yMax'])})
        pages.append({'page': index, 'width_pt': float(page.attrib['width']),
                      'height_pt': float(page.attrib['height']), 'lines': lines})
    if not pages or any(not p['lines'] for p in pages):
        raise ValueError('Empty or unmeasured rendered page')
    return {'pages': len(pages), 'geometry': pages, 'pdf_sha256': sha(pdf.read_bytes()),
            'fonts': run(['pdffonts', str(pdf)])}


def import_styles(fodt: Path) -> list[dict]:
    root = ET.parse(fodt)
    styles = {s.get(f'{{{S}}}name'): s for s in root.iter(f'{{{S}}}style')}
    out = []
    for p in root.iter():
        if p.tag not in (f'{{{T}}}p', f'{{{T}}}h'):
            continue
        style = styles.get(p.get(f'{{{T}}}style-name'))
        props = style.find(f'{{{S}}}paragraph-properties') if style is not None else None
        out.append({'text': ''.join(p.itertext()),
                    'line_height': props.get(f'{{{F}}}line-height') if props is not None else None})
    return out


def variants(source: Path, output: Path) -> tuple[dict[str, Path], dict]:
    with ZipFile(source) as z:
        parts = {n: z.read(n) for n in z.namelist()}
    doc = ET.fromstring(parts['word/document.xml'])
    styles = ET.fromstring(parts['word/styles.xml'])
    source_text = ''.join(t.text or '' for t in doc.iter(f'{{{W}}}t'))
    section = doc.find(f'.//{{{W}}}sectPr')
    if section is None:
        raise ValueError('Missing page settings')
    margins = section.find(f'{{{W}}}pgMar')
    size = section.find(f'{{{W}}}pgSz')
    floor = min(int(s.attrib[f'{{{W}}}val']) for s in doc.iter(f'{{{W}}}sz')) / 2
    evidence = {'source_docx_sha256': sha(source.read_bytes()),
        'document_xml_sha256': sha(parts['word/document.xml']),
        'styles_xml_sha256': sha(parts['word/styles.xml']),
        'minimum_explicit_font_pt': floor,
        'tables': len(list(doc.iter(f'{{{W}}}tbl'))),
        'sections': len(list(doc.iter(f'{{{W}}}sectPr'))),
        'explicit_page_breaks': sum(b.get(f'{{{W}}}type') == 'page' for b in doc.iter(f'{{{W}}}br')),
        'page_size_pt': {k: int(size.attrib[f'{{{W}}}{k}']) / 20 for k in ['w', 'h']},
        'margins_pt': {k: int(margins.attrib[f'{{{W}}}{k}']) / 20 for k in ['top', 'bottom', 'left', 'right']},
        'omitted_line_rule_elements': sum(s.get(f'{{{W}}}line') is not None and s.get(f'{{{W}}}lineRule') is None
             for root in [doc, styles] for s in root.iter(f'{{{W}}}spacing')),
        'ordered_docx_glyph_sha256': sha(glyphs(source_text).encode())}
    output.mkdir(parents=True, exist_ok=True)
    files = {}
    for label in ['original', 'explicit-auto', 'explicit-exact', 'tall-page', 'no-keepnext']:
        path = output / (label + '.docx')
        if label == 'original':
            shutil.copyfile(source, path)  # preserve exact original ZIP bytes
        else:
            with ZipFile(path, 'w', ZIP_DEFLATED) as z:
                for name, original in parts.items():
                    data = original
                    if name in ['word/document.xml', 'word/styles.xml'] and label.startswith('explicit-'):
                        rule = label.split('-', 1)[1].encode()
                        data = re.sub(rb'<w:spacing\b[^>]*w:line="[^"]+"[^>]*/>',
                            lambda m: m[0] if b'w:lineRule=' in m[0] else m[0][:-2] + b' w:lineRule="' + rule + b'"/>', data)
                    elif name == 'word/document.xml' and label == 'tall-page':
                        data = re.sub(rb'(<w:pgSz\b[^>]*\bw:h=")[0-9]+', rb'\g<1>20000', data)
                    elif name == 'word/document.xml' and label == 'no-keepnext':
                        data = re.sub(rb'<w:keepNext\b[^>]*/>', b'', data)
                    z.writestr(name, data)
            with ZipFile(path) as z:
                modified = ET.fromstring(z.read('word/document.xml'))
                if ''.join(t.text or '' for t in modified.iter(f'{{{W}}}t')) != source_text:
                    raise AssertionError('A diagnostic copy changed source text')
                if [s.attrib for s in modified.iter(f'{{{W}}}sz')] != [s.attrib for s in doc.iter(f'{{{W}}}sz')]:
                    raise AssertionError('A diagnostic copy changed font declarations')
        files[label] = path
    evidence['ordered_source_glyphs'] = glyphs(source_text)
    return files, evidence


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docx', required=True, type=Path)
    parser.add_argument('--metadata', required=True, type=Path)
    parser.add_argument('--office', action='append', required=True, help='NAME=/absolute/path/to/soffice')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text())
    if 'required_pages' not in metadata:
        raise ValueError('Input metadata must explicitly distinguish requested pages from null')
    before = sha(args.docx.read_bytes())
    output = args.output.resolve()
    files, source = variants(args.docx.resolve(), output / 'counterfactuals')
    expected = source.pop('ordered_source_glyphs')
    result = {'purpose': 'DIAGNOSTIC_REPRODUCTION_ONLY', 'source': source,
              'required_pages': metadata['required_pages'], 'professional_acceptance': 'PENDING_INDEPENDENT',
              'renderers': {}, 'counterfactuals_not_authorized_for_delivery': True}
    for spec in args.office:
        label, binary = spec.split('=', 1)
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', label):
            raise ValueError('Unsafe renderer label')
        destination = output / label
        destination.mkdir(exist_ok=True)
        renderer = {'version': run([binary, '--version']).strip(), 'variants': {}}
        for name, docx in files.items():
            with tempfile.TemporaryDirectory(prefix='katie-cross-render-') as profile:
                for fmt in ['pdf', 'fodt']:
                    run([binary, '-env:UserInstallation=' + Path(profile).as_uri(), '--headless',
                         '--convert-to', fmt, '--outdir', str(destination), str(docx)])
            pdf = destination / (name + '.pdf')
            data = geometry(pdf)
            extracted = ''.join(line['text'] for p in data['geometry'] for line in p['lines'])
            data['ordered_glyph_fidelity'] = glyphs(extracted) == expected
            if not data['ordered_glyph_fidelity']:
                raise AssertionError('Office output changed source glyphs')
            data['imported_paragraphs'] = import_styles(destination / (name + '.fodt'))
            data['requested_page_count'] = page_constraint(metadata['required_pages'], data['pages']) if name == 'original' else 'COUNTERFACTUAL'
            if name == 'original':
                run(['pdftoppm', '-png', '-scale-to', '1400', str(pdf), str(destination / 'original-page')])
            renderer['variants'][name] = data
            print(json.dumps({'renderer': label, 'variant': name, 'pages': data['pages'],
                              'source_fidelity': True, 'requested_page_count': data['requested_page_count']}), flush=True)
        result['renderers'][label] = renderer
    counts = [v['variants']['original']['pages'] for v in result['renderers'].values()]
    if metadata.get('actual_pdf_pages') is not None:
        counts.append(metadata['actual_pdf_pages'])
        result['chromium_pages_from_generator_metadata'] = metadata['actual_pdf_pages']
    result['cross_render_page_count_parity'] = parity(counts)
    if sha(args.docx.read_bytes()) != before:
        raise AssertionError('Investigation mutated the input')
    (output / 'cross-render-investigation.json').write_text(json.dumps(result, indent=2) + '\n')
    print('Evidence recorded; no professional acceptance or release authorization was granted.')


if __name__ == '__main__':
    main()
