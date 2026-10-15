"""Read both Excel voter lists and write data/voters.json for scripts/seed.mjs.

Usage: python scripts/prepare_data.py
Output (git-ignored, contains personal data): data/voters.json
"""
import json, re, sys
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
GRAD_XLSX = ROOT / "_Shivajinagar calling.xlsx"
TEACH_XLSX = ROOT / "Shivajinagar Teacher Voter List.xlsx"

GRAD_COLS = ['vidhansabha', 'part', 'serial', 'name_en', 'name_mr', 'relative', 'address',
             'education', 'occupation', 'age', 'gender', 'id_card', 'photo', 'mobile']
TEACH_COLS = ['part', 'district', 'serial', 'name_mr', 'relative', 'address', 'institution',
              'age', 'gender', 'id_card', 'remark', 'photo', 'page']

# Occupations that make a voter worth reaching early: they influence others.
LEADER_OCC = ('शिक्षक', 'डॉक्टर', 'दंतवैद्य', 'उद्योगपती', 'पोलीस', 'वैज्ञानिक', 'वकील', 'प्राध्यापक')
PG_EDU = re.compile(r'^(M[\s.]*(A|SC|COM|BA|E|TECH|CA|PHIL|ED|D|S|PHARM|ARCH)\b|PH[\s.]*D|MBBS|LL[\s.]*[BM]|CA\b|BDS|BAMS|BHMS|MD\b|POST)', re.I)


def clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s or None


def pin_of(addr):
    m = re.findall(r'\b(4\d{5})\b', addr or '')
    return m[-1] if m else None


def key(name):
    return re.sub(r'[\s.]', '', name or '')


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def tier_of(dual, occupation, education, teacher):
    if dual:
        return 1
    if teacher or any(w in (occupation or '') for w in LEADER_OCC):
        return 2
    if PG_EDU.search(education or ''):
        return 3
    return 4


def main():
    g = pd.read_excel(GRAD_XLSX, dtype=object)
    raw_grad_headers = [str(c) for c in g.columns]
    g.columns = GRAD_COLS
    t = pd.read_excel(TEACH_XLSX, dtype=object)
    raw_teach_headers = [str(c) for c in t.columns]
    t.columns = TEACH_COLS

    raw_grad = [{h: clean(v) for h, v in zip(raw_grad_headers, row)} for row in g.itertuples(index=False)]
    raw_teach = [{h: clean(v) for h, v in zip(raw_teach_headers, row)} for row in t.itertuples(index=False)]

    voters = []
    by_name = {}
    for i, r in enumerate(g.to_dict('records')):
        r = {k: clean(v) for k, v in r.items()}
        mob = r['mobile']
        v = {
            'id': f"G{to_int(r['part'])}-{to_int(r['serial'])}",
            'source': 'graduate',
            'part': to_int(r['part']), 'serial': to_int(r['serial']),
            'name_en': r['name_en'], 'name_mr': r['name_mr'], 'relative': r['relative'],
            'address': r['address'], 'pin': pin_of(r['address']),
            'education': r['education'], 'occupation': r['occupation'], 'institution': None,
            'age': to_int(r['age']), 'gender': r['gender'], 'id_card': r['id_card'],
            'mobile': mob if mob and re.fullmatch(r'\d{10}', mob) else None,
            'remark': None, 'teacher_part': None, 'teacher_serial': None, 'raw_row': i,
        }
        voters.append(v)
        by_name.setdefault(key(r['name_mr']), []).append(v)

    dual = 0
    for i, r in enumerate(t.to_dict('records')):
        r = {k: clean(v) for k, v in r.items()}
        age = to_int(r['age'])
        # Same Marathi name and either a close age (the two lists differ by up to 2 years) or the same relative.
        match = next((v for v in by_name.get(key(r['name_mr']), [])
                      if v['source'] == 'graduate' and (
                          age is None or v['age'] is None or abs(v['age'] - age) <= 2
                          or (r['relative'] and v['relative'] and key(v['relative']) in key(r['relative'])))), None)
        if match:
            dual += 1
            match.update(source='both', institution=r['institution'], remark=r['remark'],
                         teacher_part=to_int(r['part']), teacher_serial=to_int(r['serial']))
            continue
        voters.append({
            'id': f"T{to_int(r['part'])}-{to_int(r['serial'])}",
            'source': 'teacher',
            'part': to_int(r['part']), 'serial': to_int(r['serial']),
            'name_en': None, 'name_mr': r['name_mr'], 'relative': r['relative'],
            'address': r['address'], 'pin': pin_of(r['address']),
            'education': None, 'occupation': 'शिक्षक', 'institution': r['institution'],
            'age': age, 'gender': r['gender'], 'id_card': r['id_card'], 'mobile': None,
            'remark': r['remark'], 'teacher_part': to_int(r['part']), 'teacher_serial': to_int(r['serial']),
            'raw_row': i,
        })

    # Flag likely duplicate entries: same name, age and pin code listed twice.
    seen = {}
    for v in voters:
        k = (key(v['name_mr']), v['age'], v['pin'])
        v['possible_dup'] = seen.get(k)
        seen.setdefault(k, v['id'])

    for v in voters:
        v['tier'] = tier_of(v['source'] == 'both', v['occupation'], v['education'], v['source'] != 'graduate')

    ids = [v['id'] for v in voters]
    assert len(ids) == len(set(ids)), 'duplicate voter ids'
    out = ROOT / 'data' / 'voters.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({'voters': voters, 'raw_graduate': raw_grad, 'raw_teacher': raw_teach},
                              ensure_ascii=False), encoding='utf-8')
    tiers = pd.Series([v['tier'] for v in voters]).value_counts().sort_index().to_dict()
    print(f"graduate rows {len(raw_grad)}, teacher rows {len(raw_teach)}, dual {dual}, "
          f"voters {len(voters)}, with mobile {sum(1 for v in voters if v['mobile'])}, "
          f"no pin {sum(1 for v in voters if not v['pin'])}, possible duplicates {sum(1 for v in voters if v['possible_dup'])}, tiers {tiers}")


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
