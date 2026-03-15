# **Token**

Get your Discord token using this extension:

**Get cookies.txt**  
https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc

---

## **Step 1 — Requirements**
You will need:

- **cookies.txt** (exported from your browser)  
- **Admin ID**

> Use cookies.txt if you have issues such as login verification or “confirm you're not a bot”.

---

## **How to Install**

---

## **Windows**
<details>
<summary>windows</summary>

### **Step 2**  
Run **install.cmd** to install.

### **Step 3**  
Edit the **.env** file.

### **Step 4**  
Run **start.cmd** to start.

</details>

---

## **Linux**
<details>
<summary>linux</summary>

### **Step 2 — Install**
Make the install script executable:

```sh
chmod +x install.sh
```

Run the installer:

```sh
./install.sh
```

### **Step 3**  
Edit the **.env** file.

### **Step 4 — Start**
```sh
./start.sh
```

</details>
"""
path="/mnt/data/README.md"
with open(path,"w") as f:
    f.write(content)
path
