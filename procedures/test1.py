from fops import procedure

proc = procedure("bad procedure", version="1", author="stranger")

@proc.step("step1")
def step1():
    print("step1")
    
