import os
import json

def count_at_symbols(value):
    if isinstance(value, str):
        return value.count('@')
    elif isinstance(value, dict):
        return sum(count_at_symbols(v) for v in value.values())
    elif isinstance(value, list):
        return sum(count_at_symbols(v) for v in value)
    else:
        return 0

def compare_json_files(file1, file2, result_file):
    with open(file1, 'r', encoding='utf-8') as f1, open(file2, 'r', encoding='utf-8') as f2:
        json1 = json.load(f1)
        json2 = json.load(f2)
    
    def compare_dicts(d1, d2, path=""):
        differences = []
        for key in d1.keys() | d2.keys():
            new_path = f"{path}.{key}" if path else key
            if key in d1 and key in d2:
                if isinstance(d1[key], dict) and isinstance(d2[key], dict):
                    differences.extend(compare_dicts(d1[key], d2[key], new_path))
                elif count_at_symbols(d1[key]) != count_at_symbols(d2[key]):
                    differences.append(new_path)
        return differences

    return compare_dicts(json1, json2)

def compare_folders(folder1, folder2, result_file):
    files1 = {f for f in os.listdir(folder1) if f.endswith('.json')}
    files2 = {f for f in os.listdir(folder2) if f.endswith('.json')}
    
    common_files = files1 & files2
    results = []
    
    for file_name in common_files:
        file1 = os.path.join(folder1, file_name)
        file2 = os.path.join(folder2, file_name)
        differences = compare_json_files(file1, file2, result_file)
        if differences:
            for difference in differences:
                results.append(f"{file_name}: {difference}")
    
    with open(result_file, 'w', encoding='utf-8') as result_f:
        for line in results:
            result_f.write(line + '\n')

# 使用示例
folder1 = 'en-US'
folder2 = 'zh-CN'
result_file = '@checkouput.txt'

compare_folders(folder1, folder2, result_file)
