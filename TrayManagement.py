import tkinter as tk
import json
import os
import time
import optuna

from matplotlib.pylab import block, empty

# Warehouse size
floors = 8
slots = 18
filename = "warehouse_state.json"
MOVE_DELAY = 1000
# Load or create warehouse state
if os.path.exists(filename):
    with open(filename, "r") as f:
        warehouse_json = json.load(f)
    warehouse = [[bool(x) for x in row] for row in warehouse_json]
else:
    warehouse = [[False for _ in range(slots)] for _ in range(floors)]
    warehouse_json = [[0 for _ in range(slots)] for _ in range(floors)]
    with open(filename, "w") as f:
        json.dump(warehouse_json, f, indent=2)

def save_warehouse():
    warehouse_json = [[1 if x else 0 for x in row] for row in warehouse]
    with open(filename, "w") as f:
        json.dump(warehouse_json, f, indent=2)

def check_blocking_infloor(floor, slot):
    # floor, slot are 0-based
    blocking = []
    for s in range(slot):
        if warehouse[floor][s]:
            blocking.append((floor+1,s + 1))  # store 1-based slot number
    return blocking

def find_empty_slots_other_floors(current_floor, needed, placeholder, slot_time=15.0, floor_time=100.0, strategy="normal"):
    """
    Find up to 'needed' empty slots on other floors.
    
    strategy:
        - "normal": use nearest floor-first approach
        - "optuna": optimize slot selection based on time cost
    Returns a list of (floor, slot) tuples (1-based).
    """
    empty = []
    floor_indices = list(range(floors))
    floor_indices.remove(current_floor)
    
    # --- NORMAL STRATEGY ---
    if strategy == "normal":
        floor_indices.sort(key=lambda x: abs(x - current_floor))

        for f in floor_indices:
            for s in range(slots):
                if not warehouse[f][s]:
                    empty.append((f + 1, s + 1))  # Convert to 1-based
                    if len(empty) == needed:
                        if placeholder:
                            empty.append((f + 1, 0))
                        return empty
        if placeholder and empty:
            empty.append((empty[-1][0], 0))
        return empty

    # --- OPTUNA STRATEGY ---
    elif strategy == "optuna":
        candidates = []
        for f in floor_indices:
            for s in range(slots):
                if not warehouse[f][s]:
                    candidates.append((f + 1, s + 1))  # 1-based

        if len(candidates) < needed:
            return candidates + [(candidates[-1][0], 0)] if placeholder and candidates else candidates

        def objective(trial):
            indices = []
            for i in range(needed):
                idx = trial.suggest_int(f"slot_{i}", 0, len(candidates) - 1)
                indices.append(idx)

            # Reject if any duplicates (we need unique slots)
            if len(set(indices)) < needed:
                return float("inf")

            total_cost = 0
            for idx in indices:
                f, s = candidates[idx]
                floor_diff = abs((current_floor + 1) - f)  # +1 because current_floor is 0-based
                slot_diff = abs(1 - s)  # assume origin slot is 1
                handling_time = 10.0
                total_cost += 2 * (floor_diff * floor_time + slot_diff * slot_time + handling_time)

            return total_cost

        study = optuna.create_study(direction="minimize")
        study.optimize(objective, n_trials=500, show_progress_bar=True)

        # Retrieve the best unique indices
        best_indices = []
        trial = study.best_trial
        for i in range(needed):
            key = f"slot_{i}"
            if key in trial.params:
                idx = trial.params[key]
                if idx not in best_indices:
                    best_indices.append(idx)
            if len(best_indices) == needed:
                break

        best_slots = [candidates[i] for i in best_indices]

        if placeholder:
            best_slots.append((best_slots[-1][0], 0))

        return best_slots

    else:
        raise ValueError(f"Unknown strategy '{strategy}'. Use 'normal' or 'optuna'.")

def moveinside(floor,slot,target):
    """
    Move a pallet from (floor, slot) to (target_floor, target_slot).
    """
    if warehouse[floor][slot] and not warehouse[floor][target]:
        animate_move(floor, slot, floor, target)
        save_warehouse()
        update_grid()
        return f"Moved pallet from Floor {floor+1}, Slot {slot+1} to Floor {floor+1}, Slot {target+1}."
    else:
        return "Move failed: Source slot empty or target slot not empty."
def count_rightmost(floor, slot):
    """
    Count the number of free (empty) slots to the right of the given slot on the floor. 
    """
    count = 0
    for s in range(slot, slots+1):
        if not warehouse[floor-1][s-1]:
            count += 1

    return count
def count_occupied(floor):
    """
    Count the number of free (empty) slots to the right of the given slot on the floor. 
    """
    count = 0
    for s in range(1, slots+1):
        if warehouse[floor-1][s-1]:
            count += 1

    return count
def animate_move(src_floor, src_slot, dst_floor, dst_slot):
    """
    Visually move one pallet and pause.
    Assumes src currently holds a pallet and dst is empty.
    """
    # 1. Logical change
    warehouse[dst_floor][dst_slot] = warehouse[src_floor][src_slot]
    warehouse[src_floor][src_slot] = False

    # 2. UI highlight
    buttons[dst_floor][dst_slot].config(bg="yellow")      # destination flashes
    buttons[src_floor][src_slot].config(bg="blue")       # source now empty
    root.update()                                         # paint NOW

    # 3. Short pause
    root.after(MOVE_DELAY)

    # 4. Restore normal green/white colouring
    update_grid()
    
def adding(floor, slot):

    """
    Move blocking pallets on a floor to the next available empty slot to the right,
    add the new pallet, then restore the moved pallets to their original positions.
    Returns a status message.
    """
    FLOOR = floor
    SLOT = slot
    blocking = check_blocking_infloor(FLOOR, SLOT)
    output=compare_strategies(current_floor=0, blocking=blocking, slot_time=15.0, floor_time=100.0)
    if 'normal' in output:
        print("Using normal strategy")
        strategy = "normal"
    elif 'optuna' in output:
        print("Using optuna strategy")
        strategy = "optuna"
    else:
        strategy = "normal" 
    if not blocking:
        warehouse[FLOOR][SLOT] = True
        return f"Added pallet at Floor {FLOOR+1}, Slot {SLOT+1}."
    # Find empty slots on this floor to the right of the rightmost blocking slot
    if input("Enter to continue, or 'q' to quit: ") == 'q':
        return "Operation cancelled by user."
    empty = find_empty_slots_other_floors(FLOOR,len(blocking),placeholder=False,strategy=strategy)
    print(empty)
    if len(empty) < len(blocking):
        return f"Cannot move: Not enough empty slots to the right on Floor {FLOOR+1}"
    # Move blocking pallets consecutively to the right
    moves = []
    temp_blocking = sorted(blocking)
    temp_empty = sorted(empty, reverse=True)  # Sort empty slots in descending order
    print(len(temp_empty), temp_empty)
    empty_candidate = {}

    empty_candidate = {}
    for f in range(1, floors + 1):
        empty_candidate[f] = []

    # Now you can safely populate it
    for floor, slot in temp_empty:
        if slot > 0:  # ignore placeholders
            empty_candidate[floor].append(slot)
    empty_candidate = {f: slots for f, slots in empty_candidate.items() if slots}
       
    step=len(temp_blocking)
    print("Empty:  ", empty)
    print("Sort EMPTY:", temp_empty)

    for f, emptyslot in empty_candidate.items():
        print(f"Checking Floor {f}, Max Slot {max(emptyslot)}")
        target = max(emptyslot)
        for s in range ((max(emptyslot)),0,-1):
            if(warehouse[f-1][s-1] is True):
                print(f"Moving inside Floor {f}, Slot {s} to Slot {target}")
                moveinside(f-1,s-1,target-1)
                orig = (f-1, s-1)
                dest = (f-1, target-1)
                print(f"Moving from {orig} to {dest}")
                moves.append((orig, dest))
                target-=1


    new_empty = find_empty_slots_other_floors(FLOOR,len(blocking),placeholder=False,strategy="normal")
    temp_new_empty = sorted(new_empty,reverse=True)
    print(temp_new_empty)
    for block in temp_blocking:
    
        candidates = []
        for e in temp_new_empty:
            candidates.append(e)
        print("CANDIDATE",candidates)
        if not candidates:
            return f"Cannot move: No empty slot to the right of blocking slot {block[1]} on Floor {block[0]+1}"

        target = candidates[0]
        animate_move(block[0]-1, block[1]-1, target[0]-1, target[1]-1)
        orig = (block[0]-1,block[1]-1)
        dest = (target[0]-1,target[1]-1)
        print(f"orig: {orig}, dest: {dest}")
        moves.append((orig,dest))
        temp_new_empty.remove(target)
 
    # Add the new pallet
    warehouse[FLOOR][SLOT] = True
    save_warehouse()
    update_grid()

    # Restore moved pallets in reverse order
    for orig, dest in reversed(moves):
        # Move the pallet from orig to dest
        animate_move(dest[0], dest[1], orig[0], orig[1])
    save_warehouse()
    update_grid()
    
    return f"Added pallet at Floor {FLOOR+1}, Slot {SLOT+1}. Output: {output}"
def removing(floor, slot):

    """
    Move blocking pallets on a floor to the next available empty slot to the right,
    add the new pallet, then restore the moved pallets to their original positions.
    Returns a status message.
    """
    FLOOR = floor
    SLOT = slot
    blocking = check_blocking_infloor(FLOOR, SLOT)
    output=compare_strategies(current_floor=0, blocking=blocking, slot_time=15.0, floor_time=100.0)
    if 'normal' in output:
        print("Using normal strategy")
        strategy = "normal"
    elif 'optuna' in output:
        print("Using optuna strategy")
        strategy = "optuna"
    else:
        strategy = "normal" 
    
    if not blocking:
        warehouse[FLOOR][SLOT] = False
        return f"Removed pallet at Floor {FLOOR+1}, Slot {SLOT+1}."
    # Find empty slots on this floor to the right of the rightmost blocking slot
    if input("Enter to continue, or 'q' to quit: ") == 'q':
        return "Operation cancelled by user."
    empty = find_empty_slots_other_floors(FLOOR,len(blocking),placeholder=False,strategy=strategy)
    print(empty)
    if len(empty) < len(blocking):
        return f"Cannot move: Not enough empty slots to the right on Floor {FLOOR+1}"
    # Move blocking pallets consecutively to the right
    moves = []
    temp_blocking = sorted(blocking)
    temp_empty = sorted(empty, reverse=True)  # Sort empty slots in descending order
    print(len(temp_empty), temp_empty)
    empty_candidate = {}

    empty_candidate = {}
    for f in range(1, floors + 1):
        empty_candidate[f] = []

    # Now you can safely populate it
    for floor, slot in temp_empty:
        if slot > 0:  # ignore placeholders
            empty_candidate[floor].append(slot)
    empty_candidate = {f: slots for f, slots in empty_candidate.items() if slots}
       
    step=len(temp_blocking)
    print("Empty:  ", empty)
    print("Sort EMPTY:", temp_empty)

    for f, emptyslot in empty_candidate.items():
        print(f"Checking Floor {f}, Max Slot {max(emptyslot)}")
        target = max(emptyslot)
        for s in range ((max(emptyslot)),0,-1):
            if(warehouse[f-1][s-1] is True):
                print(f"Moving inside Floor {f}, Slot {s} to Slot {target}")
                moveinside(f-1,s-1,target-1)
                orig = (f-1, s-1)
                dest = (f-1, target-1)
                print(f"Moving from {orig} to {dest}")
                moves.append((orig, dest))
                target-=1


    new_empty = find_empty_slots_other_floors(FLOOR,len(blocking),placeholder=False,strategy="normal")
    temp_new_empty = sorted(new_empty,reverse=True)
    print(temp_new_empty)
    for block in temp_blocking:
    
        candidates = []
        for e in temp_new_empty:
            candidates.append(e)
        print("CANDIDATE",candidates)
        if not candidates:
            return f"Cannot move: No empty slot to the right of blocking slot {block[1]} on Floor {block[0]+1}"

        target = candidates[0]
        animate_move(block[0]-1, block[1]-1, target[0]-1, target[1]-1)
        orig = (block[0]-1,block[1]-1)
        dest = (target[0]-1,target[1]-1)
        print(f"orig: {orig}, dest: {dest}")
        moves.append((orig,dest))
        temp_new_empty.remove(target)
 
    # Remove the new pallet
    warehouse[FLOOR][SLOT] = False
    save_warehouse()
    update_grid()

    # Restore moved pallets in reverse order
    for orig, dest in reversed(moves):
        # Move the pallet from orig to dest
        animate_move(dest[0], dest[1], orig[0], orig[1])
    save_warehouse()
    update_grid()
    
    return f"Added pallet at Floor {FLOOR+1}, Slot {SLOT+1}. Output: {output}"
def compare_strategies(current_floor, blocking, slot_time=1.0, floor_time=4.0, placeholder=False):
    needed = len(blocking)

    # Run normal strategy
    normal_slots = find_empty_slots_other_floors(
        current_floor=current_floor,
        needed=needed,
        placeholder=placeholder,
        slot_time=slot_time,
        floor_time=floor_time,
        strategy="normal"
    )

    # Run optuna strategy
    optuna_slots = find_empty_slots_other_floors(
        current_floor=current_floor,
        needed=needed,
        placeholder=placeholder,
        slot_time=slot_time,
        floor_time=floor_time,
        strategy="optuna"
    )

    # Calculate total cost for each
    def total_cost(assignments, blocking):
        cost = 0
        for (from_f, from_s), (to_f, to_s) in zip(blocking, assignments):
            floor_diff = abs(from_f - to_f)
            slot_diff = abs(from_s - to_s)
            handling_time = 10.0
            cost += 2*floor_diff * floor_time + slot_diff * slot_time + handling_time
        return cost

    normal_cost = total_cost(normal_slots[:needed], blocking)
    optuna_cost = total_cost(optuna_slots[:needed], blocking)

    print(f"\n--- Strategy Comparison ---")
    print(f"Blocking pallets: {blocking}")
    print(f"Normal strategy slots: {normal_slots[:needed]}, total time: {normal_cost}")
    print(f"Optuna strategy slots: {optuna_slots[:needed]}, total time: {optuna_cost}")

    # Optional visual comparison
    if normal_cost < optuna_cost:
        print("✅ Normal strategy is faster.")
        return "normal"
    elif optuna_cost < normal_cost:
        print("✅ Optuna strategy is faster.")
        return "optuna"
    else:
        
        print("⚖️ Both strategies are equal.")
        return "normal"
def update_grid():
    for f in range(floors):
        for s in range(slots):
            btn = buttons[f][s]
            btn.config(
                text="X" if warehouse[f][s] else ".",
                bg="lightgreen" if warehouse[f][s] else "white"
            )

def on_cell_click(f, s):
    # Show blocking info
    

    if False:
        status.set(f"Blocked by slots: {blocking} on Floor {f+1}")
        empty = find_empty_slots_other_floors(f,len(blocking))
        print(empty)
    else:
        if warehouse[f][s] == False:
            msg=adding(f,s)
            status.set(msg)
        elif warehouse[f][s] == True:
            msg=removing(f,s)
            status.set(msg)
    save_warehouse()
    update_grid()


root = tk.Tk()
root.title("Warehouse Viewer")

# Header row for slot numbers
tk.Label(root, text="", width=8).grid(row=0, column=0)
for s in range(slots):
    tk.Label(root, text=f"{s+1:2}", width=3, borderwidth=1, relief="solid").grid(row=0, column=s+1)

buttons = []
for f in range(floors):
    tk.Label(root, text=f"Floor {f+1}", width=8, borderwidth=1, relief="solid").grid(row=f+1, column=0)
    row_btns = []
    for s in range(slots):
        btn = tk.Button(
            root,
            text="X" if warehouse[f][s] else ".",
            width=3,
            command=lambda f=f, s=s: on_cell_click(f, s)
        )
        btn.grid(row=f+1, column=s+1)
        row_btns.append(btn)
    buttons.append(row_btns)

status = tk.StringVar()
status.set("Ready.")
tk.Label(root, textvariable=status, anchor="w", width=80).grid(row=floors+1, column=0, columnspan=slots+1, sticky="w")

update_grid()
root.mainloop()