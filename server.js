
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
console.log('All Environment Variables:', process.env);
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
console.log('Stripe Secret Key:', process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'uploads'));
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage });

// mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true,ssl: false  })
//     .then(() => console.log('MongoDB connected'))
//     .catch(err => console.error(err));
mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000 // 30 seconds timeout
})
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// mongoose.connect(process.env.MONGO_URI, {
//     useNewUrlParser: true,
//     useUnifiedTopology: true,
// }).then(() => {
//     console.log('MongoDB connected');
// }).catch(err => {
//     console.error('MongoDB connection error:', err);
// });

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String},
});
const User = mongoose.model('User', userSchema);

const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String, required: true },
    price: { type: Number, required: true },
    stock: { type: Number, required: true },
    image: { type: String }
});

const Product = mongoose.model('Product', productSchema);

const cartSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, quantity: Number }]
});
const Cart = mongoose.model('Cart', cartSchema);

const orderSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    products: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, quantity: Number }],
    total: { type: Number, required: false }
});
const Order = mongoose.model('Order', orderSchema);

const sessionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    loginTime: { type: Date, required: true },
    logoutTime: { type: Date },
    ipAddress: { type: String, required: true }
});
const Session = mongoose.model('Session', sessionSchema);

const paymentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    transaction: { type: String, required: true },
    status: { type: String, required: true, default: 'pending' },
    paymentIntentId: { type: String, required: true },
    paymentMethod: { type: String, required: true },
    user: { type: String, required: true }
});

// const paymentSchema = new mongoose.Schema({
//     user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
//     amount: { type: Number, required: true }, // Amount in cents
//     currency: { type: String, default: 'usd' },
//     paymentMethod: { type: String, required: true },
//     paymentIntentId: { type: String, required: true },
//     status: { 
//         type: String, 
//         enum: [
//             'requires_payment_method', 
//             'requires_confirmation', 
//             'requires_action', 
//             'processing', 
//             'requires_capture', 
//             'canceled', 
//             'succeeded'
//         ], 
//         required: true 
//     },
//     createdAt: { type: Date, default: Date.now }
// });
const Payment = mongoose.model('Payment', paymentSchema);

const authMiddleware = async (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

app.post('/register', async (req, res) => {
    const { email, password,role } = req.body;
    console.log(role)
    const { data, error } = await supabase.auth.signUp({ email, password,role });
    console.log(data)
    if (error) return res.status(400).json({ error: error.message });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword ,role});
    await user.save();
    res.status(201).json({ message: 'User registered' });
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(email,password)
    const user = await User.findOne({ email });
    console.log(user)
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const session = new Session({
        user: user._id,
        loginTime: new Date(),
        ipAddress: req.ip 
    });
    await session.save();
    res.json({ token,role: user.role });
});

app.post('/products', upload.single('image'), async (req, res) => {
    if (req.user && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const { name, price, description, stock } = req.body;
        let imageBase64 = '';
        
        if (req.file) {
            // Read the image file and convert to Base64
            const imagePath = path.join(__dirname, 'uploads', req.file.filename);
            const imageData = fs.readFileSync(imagePath);
            imageBase64 = `data:${req.file.mimetype};base64,${imageData.toString('base64')}`;
        }

        const product = new Product({ name, price, description, stock, image: imageBase64 });
        await product.save();
        
        res.status(201).json("Product added successfully");
    } catch (err) {
        console.error('Error adding product:', err);
        res.status(500).json({ error: 'Failed to add product' });
    }
});

app.get('/products', async (req, res) => {
    const products = await Product.find();
    res.json(products);
});

app.put('/products/:productId', authMiddleware, upload.single('image'), async (req, res) => {
    console.log('Product ID:', req.params.productId);
    console.log('Request Body:', req.body);

    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    const updateData = {
        name: req.body.name,
        price: req.body.price,
        description: req.body.description,
        stock: req.body.stock,
    };

    if (req.file) {
        const imagePath = path.join(__dirname, 'uploads', req.file.filename);
        const imageData = fs.readFileSync(imagePath);
        updateData.image = `data:${req.file.mimetype};base64,${imageData.toString('base64')}`;
    }

    try {
        const product = await Product.findByIdAndUpdate(req.params.productId, updateData, { new: true });
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        res.json('Product updated');
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


app.delete('/products/:productId', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    const product = await Product.findByIdAndDelete(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted' });
});

app.post('/cart', authMiddleware, async (req, res) => {
    const { productId, quantity } = req.body;

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    let cart = await Cart.findOne({ user: req.user._id });
    if (!cart) {
        cart = new Cart({ user: req.user._id, items: [] });
    }

    const existingItem = cart.items.find(item => item.product.equals(productId));
    if (existingItem) {
        existingItem.quantity += quantity;
    } else {
        cart.items.push({ product: productId, quantity });
    }

    await cart.save();
    res.status(200).json({ message: 'Product added to cart', cart });
});

app.get('/cart', authMiddleware, async (req, res) => {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
    // if (!cart) return res.status(404).json({ error: 'Cart not found' });

    res.json(cart);
});

app.delete('/cart/:productId', authMiddleware, async (req, res) => {
    const { productId } = req.params;
    
    const cart = await Cart.findOne({ user: req.user._id });
    // if (!cart) return res.status(404).json({ error: 'Cart not found' });

    cart.items = cart.items.filter(item => !item.product.equals(productId));
    console.log(cart.items)
    await cart.save();
     console.log(cart)
    res.json({ message: 'Item removed from cart', cart });
    console.log('Item removed from cart')
});
``
app.post('/order', authMiddleware, async (req, res) => {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
    if (!cart || cart.items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const total = cart.items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    console.log(total)

    const orderItems = cart.items.map(item => ({
        product: item.product._id,
        quantity: item.quantity,
        name: item.product.name,
        price: item.product.price,
        image: item.product.image 
    }));

    const order = new Order({
        user: req.user._id,
        products: orderItems,
        total
    });

    try {
        await order.save();
        await Cart.findOneAndDelete({ user: req.user._id }); // Clear the cart after order is placed
        res.status(201).json({ message: 'Order placed', order });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to place order' });
    }
});

app.get('/orders', authMiddleware, async (req, res) => {
    const orders = await Order.find({ user: req.user._id }).populate('products.product');
    res.json(orders);
});


app.get('/sessions', authMiddleware, async (req, res) => {
    const sessions = await Session.find({ user: req.user._id });
    res.json(sessions);
});

app.post('/create-payment', async (req, res) => {
    const { name, amount, transaction } = req.body;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Payment for transaction ' + transaction,
                    },
                    unit_amount: amount * 100, // amount in cents
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'http://localhost:3000/orders', 
            cancel_url: 'http://localhost:3000/failure',   
            
        });
        
        // Save payment information in MongoDB
        const payment = new Payment({
            name: name,
            amount: amount,
            transaction: transaction,
            status: 'pending',
            paymentIntentId: session.id,
            paymentMethod: 'card',
            user: 'some-user-id' // Replace with actual user ID or identifier
        });

        await payment.save();

        res.json({ id: session.id });
    } catch (error) {
        console.error("Error creating Stripe session:", error);
        res.status(500).json({ error: "Error creating Stripe session" });
    }
});


// app.post('/payment',authMiddleware, async (req, res) => {
//     const { totalAmount, paymentMethod } = req.body;
//     console.log( totalAmount, paymentMethod)

//     if (!totalAmount || !paymentMethod) {
//         return res.status(400).json({ error: 'Amount and paymentMethod are required' });
//     }

//     try {
//         // Create a PaymentIntent
//         const paymentIntent = await stripe.paymentIntents.create({
//             amount:totalAmount,
//             currency: 'usd',
//             payment_method: paymentMethod,
//             confirm: true,
//             return_url: 'http://localhost:3001/orders' 
//         });

//         console.log(paymentIntent);
//         // Save payment information to database
//         const payment = new Payment({
//             user: req.user._id, // Assuming req.user contains authenticated user info
//             amount,
//             currency: 'usd',
//             paymentMethod,
//             paymentIntentId: paymentIntent.id,
//             status: paymentIntent.status
//         });

//         console.log(payment)
//         await payment.save();

//         // Respond with the payment intent
//         res.status(200).json("payment successfully");
//         console.log("sucess")
//     } catch (error) {
//         console.error('Payment error:', error);
//         res.status(500).json({ error: 'Payment failed', details: error.message });
//     }
// });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));