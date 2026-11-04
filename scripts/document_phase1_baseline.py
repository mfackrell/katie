#!/usr/bin/env python3
"""Offline Phase-1 artifact regression. Requires LibreOffice, pdfinfo; stdlib only.
Usage: python3 scripts/document_phase1_baseline.py /path/to/rejected.docx
Baseline uses the actual rejected resume; never edit its wording/font to meet fit.
The original fixture is intentionally not stored in the repository (personal data).
"""
import argparse
import hashlib
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

def contents(path):
    with zipfile.ZipFile(path) as z:
        return {n:z.read(n) for n in z.namelist()}

def inspect_docx(path):
    root=ET.fromstring(contents(path)["word/document.xml"])
    text="".join(n.text or "" for n in root.iter(W+"t"))
    sizes=[int(n.get(W+"val")) for n in root.iter(W+"sz") if n.get(W+"val")]
    return {"text_hash":hashlib.sha256(text.encode()).hexdigest(),
            "text_length":len(text), "sections":len(list(root.iter(W+"sectPr"))),
            "explicit_breaks":sum(n.get(W+"type")=="page" for n in root.iter(W+"br")),
            "min_run_halfpoints":min(sizes) if sizes else None}

def variant(src, dst, compact=False):
    items=contents(src); root=ET.fromstring(items["word/document.xml"])
    for para in root.iter(W+"p"):
        ppr=para.find(W+"pPr")
        if ppr is not None:
            for sec in list(ppr.findall(W+"sectPr")): ppr.remove(sec)
            if compact:
                if ppr is None: ppr=ET.SubElement(para,W+"pPr")
                sp=ppr.find(W+"spacing")
                if sp is None: sp=ET.SubElement(ppr,W+"spacing")
                sp.set(W+"line","240");sp.set(W+"lineRule","auto")
                for a,limit in (("before",60),("after",40)):
                    v=sp.get(W+a)
                    if v is not None:sp.set(W+a,str(min(int(v),limit)))
    if compact:
        for sect in root.iter(W+"sectPr"):
            for mar in sect.iter(W+"pgMar"):
                for a in ("top","bottom","left","right"):mar.set(W+a,"720")
    items["word/document.xml"]=ET.tostring(root,encoding="utf-8",xml_declaration=True)
    with zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as z:
        for name,data in items.items():z.writestr(name,data)

def render(docx,outdir):
    cmd=["libreoffice","-env:UserInstallation=file://"+str(outdir/"profile"),"--headless",
         "--convert-to","pdf","--outdir",str(outdir),str(docx)]
    subprocess.run(cmd,check=True,capture_output=True,text=True,timeout=90)
    pdf=outdir/(docx.stem+".pdf")
    info=subprocess.run(["pdfinfo",str(pdf)],check=True,capture_output=True,text=True).stdout
    count=int(re.search(r"^Pages:\s*(\d+)",info,re.M).group(1))
    return pdf,count

def main():
    ap=argparse.ArgumentParser();ap.add_argument("rejected_docx",type=Path)
    a=ap.parse_args();original=a.rejected_docx.resolve()
    with tempfile.TemporaryDirectory(prefix="katie-doc-baseline-") as tmp:
        tmp=Path(tmp)
        natural=tmp/"natural.docx";compact=tmp/"compact.docx"
        variant(original,natural);variant(original,compact,True)
        stats={name:inspect_docx(p) for name,p in (("original",original),("natural",natural),("compact",compact))}
        assert len({x["text_hash"] for x in stats.values()})==1,"Wording/glyphs changed"
        assert stats["compact"]["min_run_halfpoints"]==stats["original"]["min_run_halfpoints"],"Font size changed"
        pages={name:render(p,tmp)[1] for name,p in (("original",original),("natural",natural),("compact",compact))}
        print("DOCX",stats);print("LibreOffice pages",pages)
        assert pages["original"]==3,"Original failure not reproduced: update fixture/investigate"
        assert pages["natural"]==3,"Natural reflow unexpectedly changed: investigate renderer"
        assert pages["compact"]==2,"Two-page compact feasibility not reproduced"
        print("REPRODUCTION PASS. Known original delivery defect remains EXPECTED FAIL: 3 != requested 2")
        print("NOTE: This experiment changes XML layout only; it does not validate Katie's end-to-end generator.")
if __name__=="__main__":main()
