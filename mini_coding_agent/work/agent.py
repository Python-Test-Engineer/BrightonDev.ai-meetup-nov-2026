import random
import subprocess
import sys
import datetime


def main():
    # Generate a random 4-digit number between 1000 and 9999
    number = random.randint(1000, 9999)
    filename = f"test{number}.py"

    # Hello world script content
    hello_script = (
        'import datetime\n'
        'print("Hello, World!")\n'
        'print("Timestamp:", datetime.datetime.now())\n'
    )

    with open(filename, "w") as f:
        f.write(hello_script)

    print(f"Created {filename}")

    # Run it 3 times and save output including date time stamp into a file
    output_file = f"test{number}_output.txt"
    with open(output_file, "w") as out:
        for i in range(1, 4):
            out.write(f"===== Run {i} =====\n")
            out.write(f"Run time: {datetime.datetime.now()}\n")
            result = subprocess.run(
                [sys.executable, filename],
                capture_output=True,
                text=True,
            )
            out.write(result.stdout)
            if result.stderr:
                out.write("STDERR:\n" + result.stderr)
            out.write("\n")

    print(f"Ran {filename} 3 times, output saved to {output_file}")
    with open(output_file) as out:
        print(out.read())


if __name__ == "__main__":
    main()
