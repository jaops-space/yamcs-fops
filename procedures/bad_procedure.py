from fops import procedure

proc = procedure(name="bad_procedure")

@proc.step(name="step1")
def step1():
    bubu
