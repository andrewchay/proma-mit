import hashlib, json, re, sys
from pathlib import Path

def validate(root):
    root=Path(root).resolve()
    manifest=json.loads((root/'manifest.json').read_text())
    catalog=json.loads((root/'catalog.json').read_text())
    assert manifest['roleCount']==20
    assert manifest['coreRoleCount']==13 and manifest['specialistRoleCount']==7
    assert catalog['employeeInstancesCreated']==0 and catalog['runtimeIntegrated'] is False
    assert catalog['modelBinding'] is None and catalog['status']=='draft-unbound'
    entries=manifest['files']
    slugs={e['roleSlug'] for e in entries}
    assert len(slugs)==20 and len(entries)==20
    assert not any(x in s for s in slugs for x in ['shepherd','project-manager','chief-of-staff'])
    index={r['roleSlug']:r for f in catalog['functions'] for r in f['roles']}
    assert set(index)==slugs
    assert len(catalog['functions'])==11
    counts={'core':0,'specialist':0}
    case_count=0
    for e in entries:
        for pathkey,hashkey in [('cardPath','cardSha256'),('contractPath','contractSha256'),('casesPath','casesSha256')]:
            p=(root/e[pathkey]).resolve()
            assert p.is_relative_to(root) and p.is_file()
            assert hashlib.sha256(p.read_bytes()).hexdigest()==e[hashkey],p
        c=json.loads((root/e['cardPath']).read_text())
        assert c['slug']==e['roleSlug'] and index[c['slug']]['cardPath']==e['cardPath']
        assert c['status']=='draft-unbound' and c['executable'] is False
        assert c['executionProfile']=='general' and c['permissionModeRecommendation']=='safe'
        assert c['roleVersion']==manifest['version']
        assert all(c[k] is None for k in ['employeeId','runtime','channelId','modelId','workspaceId'])
        assert c['costEstimate']['status']=='unknown'
        assert len(c['summary'])<=100
        for k in ['inputs','deliverables','useWhen','notFor','acceptanceCriteria','humanConfirmationTriggers']:
            assert c[k] and all(isinstance(x,str) and x.strip() for x in c[k])
        assert set(c['handoffRoles'])<=slugs
        counts[c['tier']]+=1
        body=(root/e['contractPath']).read_text()
        assert len(body)>1000 and '共通执行规则（L2 必须完整加载）' in body
        assert '不自行组织任务链' in body and '费用未知' in body and '隐含思维链' in body
        assert '## 验收标准' in body and '## 交付回执' in body and '## 来源与改造' in body
        tests=json.loads((root/e['casesPath']).read_text())
        assert tests['roleSlug']==c['slug'] and tests['status']=='not-run-against-model'
        assert len(tests['cases'])==4
        case_count+=len(tests['cases'])
        for test in tests['cases']:
            assert all(test[k] for k in ['name','given','when','then'])
    assert counts=={'core':13,'specialist':7}
    for md in root.rglob('*.md'):
        for target in re.findall(r'\]\(([^)]+)\)',md.read_text()):
            if '://' not in target and not target.startswith('#'):
                assert (md.parent/target.split('#')[0]).exists(),(md,target)
    provenance=json.loads((root/'provenance.json').read_text())
    assert provenance['license']=='MIT' and len(provenance['referenceHead'])==40
    assert 'Copyright (c) 2025 AgentLand Contributors' in (root/'licenses/agency-agents-MIT.txt').read_text()
    assert 'Permission is hereby granted' in (root/'licenses/agency-agents-MIT.txt').read_text()
    assert all(s in provenance['sources'] for e in entries for s in json.loads((root/e['cardPath']).read_text())['sourceFiles'])
    special={
        'requirements-analyst':'不替人拍板',
        'feedback-analyst':'AI 模拟意见当用户数据',
        'delivery-verifier':'不凭模型报告',
        'ai-behavior-designer':'不自行激活',
        'legal-reviewer':'司法辖区',
        'recruitment-assistant':'受保护属性',
        'financial-planner':'预测收入不当实际收入',
    }
    for slug,phrase in special.items():
        assert phrase in (root/f'roles/{slug}.md').read_text(),slug
    return {'root':str(root),'roleCount':20,'core':13,'specialists':7,'functions':11,'behaviorCases':case_count,'artifactIntegrity':'pass','modelBehaviorEvaluation':'not-run','runtimeIntegration':'not-implemented','employeeInstancesCreated':0}

if __name__=='__main__':
    print(json.dumps(validate(sys.argv[1]),ensure_ascii=False,indent=2))
