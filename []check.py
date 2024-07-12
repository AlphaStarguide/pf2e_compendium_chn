import os
import json

def find_unbalanced_brackets_in_json_files(directory, output_file):
    def check_balanced_brackets(value):
        """ Check if the number of '[' matches the number of ']' in the value. """
        open_brackets = value.count('[')
        close_brackets = value.count(']')
        return open_brackets == close_brackets

    def traverse_json(data, current_path=""):
        """ Recursively traverse the JSON data and check each value for balanced brackets. """
        if isinstance(data, dict):
            for key, value in data.items():
                path = f"{current_path}.{key}" if current_path else key
                if isinstance(value, (dict, list)):
                    traverse_json(value, path)
                elif isinstance(value, str) and not check_balanced_brackets(value):
                    unbalanced_keys.append((path, value))
        elif isinstance(data, list):
            for index, item in enumerate(data):
                path = f"{current_path}[{index}]"
                traverse_json(item, path)
    
    unbalanced_keys = []

    # Traverse all JSON files in the specified directory
    for root, _, files in os.walk(directory):
        for file in files:
            if file.endswith('.json'):
                file_path = os.path.join(root, file)
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    unbalanced_keys = []
                    traverse_json(data)
                    if unbalanced_keys:
                        with open(output_file, 'a', encoding='utf-8') as out_f:
                            for path, value in unbalanced_keys:
                                out_f.write(f"{file_path}: {path} -> {value}\n")
                except json.JSONDecodeError:
                    print(f"Error decoding JSON in file {file_path}")
                except Exception as e:
                    print(f"Error processing file {file_path}: {e}")

# 使用示例
directory_to_check = 'zh-CN'
output_file = 'unbalanced_brackets_output.txt'
find_unbalanced_brackets_in_json_files(directory_to_check, output_file)
