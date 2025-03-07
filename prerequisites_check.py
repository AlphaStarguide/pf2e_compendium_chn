import os
import json
from pathlib import Path

# 定义文件夹路径
en_us_folder = "en-US"
zh_cn_folder = "zh-CN"
output_file = "missing_prerequisites.txt"

# 存储结果的列表
missing_prerequisites_files = []

# 递归函数，用于遍历JSON对象并检查prerequisites键
def check_prerequisites(en_obj, zh_obj, path=""):
    missing_paths = []
    
    if isinstance(en_obj, dict) and isinstance(zh_obj, dict):
        # 检查当前级别
        if 'prerequisites' not in en_obj and 'prerequisites' in zh_obj:
            missing_paths.append(path)
            
        # 递归检查所有子对象
        for key in en_obj:
            if key in zh_obj:
                # 如果两边都有这个键，且值是dict或list，则递归检查
                if isinstance(en_obj[key], (dict, list)) and isinstance(zh_obj[key], (dict, list)):
                    sub_path = f"{path}.{key}" if path else key
                    sub_results = check_prerequisites(en_obj[key], zh_obj[key], sub_path)
                    missing_paths.extend(sub_results)
    
    elif isinstance(en_obj, list) and isinstance(zh_obj, list):
        # 如果是列表，则检查每个元素
        for i, (en_item, zh_item) in enumerate(zip(en_obj, zh_obj)):
            if isinstance(en_item, (dict, list)) and isinstance(zh_item, (dict, list)):
                sub_path = f"{path}[{i}]"
                sub_results = check_prerequisites(en_item, zh_item, sub_path)
                missing_paths.extend(sub_results)
    
    return missing_paths

# 获取en-US文件夹中的所有JSON文件
en_us_files = [f for f in os.listdir(en_us_folder) if f.endswith('.json')]

# 遍历每个文件
for filename in en_us_files:
    # 构建完整路径
    en_path = os.path.join(en_us_folder, filename)
    zh_path = os.path.join(zh_cn_folder, filename)
    
    # 检查对应的中文文件是否存在
    if not os.path.exists(zh_path):
        print(f"警告: 在zh-CN文件夹中找不到对应的文件: {filename}")
        continue
    
    # 读取两个文件
    try:
        with open(en_path, 'r', encoding='utf-8') as f:
            en_data = json.load(f)
        
        with open(zh_path, 'r', encoding='utf-8') as f:
            zh_data = json.load(f)
        
        # 检查整个JSON树
        missing_paths = check_prerequisites(en_data, zh_data)
        
        if missing_paths:
            for path in missing_paths:
                missing_prerequisites_files.append(f"{en_path} 中 {path} 缺少prerequisites键，但在 {zh_path} 中存在")
    
    except json.JSONDecodeError as e:
        print(f"错误: 解析JSON文件 {filename} 失败: {e}")
    except Exception as e:
        print(f"处理文件 {filename} 时出错: {e}")

# 将结果写入输出文件
with open(output_file, 'w', encoding='utf-8') as f:
    f.write(f"共找到 {len(missing_prerequisites_files)} 个文件满足条件\n\n")
    for item in missing_prerequisites_files:
        f.write(f"{item}\n")

print(f"比较完成! 结果已保存到 {output_file}")