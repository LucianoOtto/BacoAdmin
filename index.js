const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();
require('dotenv').config();
app.use(express.json());
app.use(cors({
  origin: function (origin, callback) {
    // Permitir peticiones sin origen (como Postman o el propio servidor) o las que estén en la lista
    if (!origin || origenesPermitidos.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado por políticas de CORS de BacoTickets'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
})); 

const origenesPermitidos = [
  'http://localhost:5173',                         
  'https://animated-platypus-df4a3d.netlify.app' 
];
const compradoresPath = path.join(__dirname, 'compradores.json');
const rrppPath = path.join(__dirname, 'rrpp.json'); 
const bebidaPath = path.join(__dirname, 'bebida.json');
const valesOtorgadosPath = path.join(__dirname, 'vales-otorgados.json'); 
const stockInsumosPath = path.join(__dirname, 'stock-insumos.json');
const tandasPath = path.join(__dirname, 'tandas.json'); // NUEVO: precios de entradas por tanda
const gastosPath = path.join(__dirname, 'gastos.json'); // NUEVO: gastos del evento (nombre, descripción, precio)

// Almacenamiento temporal en memoria para las sesiones activas
const sesionesActivas = {};
const DURACION_SESION_MS = 2 * 60 * 60 * 1000; 

const CATALOGO_BEBIDAS = {
    'Fernet': 3500,          // Jarra de Fernet con Coca-Cola
    'Cerveza': 2000,
    'Vodka': 3000,           // Jarra de Vodka con Sprite
    'Agua': 1000,
    'Jarra Gaseosa': 1000,   // Jarra de gaseosa sola (Coca-Cola o Sprite, a elección) - AJUSTAR PRECIO SI CORRESPONDE
    'Lata Energizante': 2500
};

// ==========================================
// INSUMOS FÍSICOS DE BARRA (lo que se carga como stock real)
// ==========================================
const INSUMOS = {
    'Fernet': { tipo: 'botella' },
    'Vodka': { tipo: 'botella' },
    'Coca-Cola': { tipo: 'botella' },
    'Sprite': { tipo: 'botella' },
    'Cerveza': { tipo: 'unidad' },
    'Agua': { tipo: 'unidad' },
    'Lata Energizante': { tipo: 'unidad' }
};

// ==========================================
// RECETAS: cuánta fracción de cada insumo consume UNA unidad vendida
// ==========================================
const RECETAS = {
    'Fernet': [
        { insumo: 'Fernet', fraccion: 1 / 7 },
        { insumo: 'Coca-Cola', fraccion: 1 / 3 }
    ],
    'Vodka': [
        { insumo: 'Vodka', fraccion: 1 / 7 },
        { insumo: 'Sprite', fraccion: 1 / 3 }
    ],
    'Cerveza': [{ insumo: 'Cerveza', fraccion: 1 }],
    'Agua': [{ insumo: 'Agua', fraccion: 1 }],
    'Lata Energizante': [{ insumo: 'Lata Energizante', fraccion: 1 }],
};

// Calcula cuánto se consume de cada insumo para una venta puntual
function calcularConsumoInsumos(venta) {
    const { producto, cantidad, sabor } = venta;

    if (producto === 'Jarra Gaseosa') {
        if (!sabor || (sabor !== 'Coca-Cola' && sabor !== 'Sprite')) return [];
        return [{ insumo: sabor, cantidad: cantidad * 0.5 }];
    }

    const receta = RECETAS[producto];
    if (!receta) return [];

    return receta.map(({ insumo, fraccion }) => ({
        insumo,
        cantidad: cantidad * fraccion
    }));
}

// ==========================================
// TANDAS DE ENTRADAS (precios que van cambiando: primera, segunda, tercera)
// Se persisten en tandas.json para poder actualizarlas desde el panel de admin
// sin tener que tocar el código ni reiniciar el servidor.
// ==========================================
async function leerTandas() {
    try {
        const data = await fs.readFile(tandasPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // Si el archivo no existe todavía, lo creamos con valores por defecto
        const porDefecto = {
            primera: 5000,
            segunda: 7000,
            tercera: 10000,
            tandaActiva: 'primera' 
        };
        await guardarArchivo(tandasPath, porDefecto);
        return porDefecto;
    }
}


const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // Debe ser false para el puerto 587
  requireTLS: true, // 👈 FUERZA a que la conexión use TLS obligatorio
  auth: {
    user: process.env.GMAILAPI,
    pass: process.env.PASSAPI
  },
  tls: {
    ciphers: 'SSLv3', 
    rejectUnauthorized: false
  }
});

// ==========================================
// FUNCIONES AUXILIARES (FILE SYSTEM)
// ==========================================
async function leerArchivo(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function guardarArchivo(filePath, datos) {
    await fs.writeFile(filePath, JSON.stringify(datos, null, 2), 'utf-8');
}

// ==========================================
// MIDDLEWARE DE PROTECCIÓN DE RUTAS
// ==========================================
function verificarSesion(rolesPermitidos = []) {
    return (req, res, next) => {
        const token = req.headers['authorization'];

        if (!token || !sesionesActivas[token]) {
            return res.status(401).json({ error: 'Sesión no iniciada o inválida' });
        }

        const sesion = sesionesActivas[token];

        if (new Date() > sesion.expira) {
            delete sesionesActivas[token];
            return res.status(401).json({ error: 'La sesión ha expirado. Por favor, iniciá sesión nuevamente.' });
        }

        if (sesion.rol === 'admin') {
            sesion.expira = new Date(Date.now() + DURACION_SESION_MS);
            req.usuarioSesion = sesion;
            return next();
        }

        if (rolesPermitidos.length > 0 && !rolesPermitidos.includes(sesion.rol)) {
            return res.status(403).json({ error: 'No tenés permisos para realizar esta acción' });
        }

        sesion.expira = new Date(Date.now() + DURACION_SESION_MS);
        req.usuarioSesion = sesion; 
        next();
    };
}

// ==========================================
// RUTAS DE AUTENTICACIÓN Y ROLES
// ==========================================

// CORREGIDO: Ahora el campo email es requerido obligatoriamente en el registro
app.post('/api/auth/registrar-personal', async (req, res) => {
    const { nombre, usuario, password, rol, email } = req.body;

    if (!nombre || !usuario || !password || !rol || !email) {
        return res.status(400).json({ error: 'Faltan campos requeridos (Nombre, Usuario, Password, Rol y Email)' });
    }

    if (rol !== 'rrpp' && rol !== 'barra' && rol !== 'control' && rol !== 'admin') {
        return res.status(400).json({ error: 'Rol inválido. Debe ser: rrpp, barra, control o admin' });
    }

    const personal = await leerArchivo(rrppPath);
    
    if (personal.find(p => p.usuario.toLowerCase() === usuario.toLowerCase())) {
        return res.status(400).json({ error: 'El nombre de usuario ya está registrado' });
    }

    if (personal.find(p => p.email && p.email.toLowerCase() === email.toLowerCase())) {
        return res.status(400).json({ error: 'El correo electrónico ya está registrado por otro usuario' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordEncriptada = await bcrypt.hash(password, salt);

    const nuevoUsuario = {
        id: uuidv4().split('-')[0], 
        nombre,
        usuario,
        password: passwordEncriptada,
        rol,
        email: email.trim(), 
        historias: 0 
    };

    personal.push(nuevoUsuario);
    await guardarArchivo(rrppPath, personal);

    res.status(201).json({ mensaje: 'Usuario registrado con éxito', rol: nuevoUsuario.rol });
});

app.post('/api/auth/login', async (req, res) => {
    const { usuario, password } = req.body;
    const personal = await leerArchivo(rrppPath);

    const usuarioEncontrado = personal.find(p => p.usuario === usuario);

    if (!usuarioEncontrado) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const passwordCorrecta = await bcrypt.compare(password, usuarioEncontrado.password);

    if (!passwordCorrecta) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const token = uuidv4();
    
    sesionesActivas[token] = {
        usuarioId: usuarioEncontrado.id,
        nombre: usuarioEncontrado.nombre,
        rol: usuarioEncontrado.rol,
        expira: new Date(Date.now() + DURACION_SESION_MS)
    };

    res.json({
        mensaje: 'Login exitoso',
        token,
        rol: usuarioEncontrado.rol,
        nombre: usuarioEncontrado.nombre
    });
});

// ==========================================
// RUTAS DE TANDAS (consulta pública para vendedores, edición solo admin)
// ==========================================

// Cualquier rrpp o admin puede consultar los precios vigentes antes de vender
app.get('/api/tandas', verificarSesion(['rrpp', 'barra', 'control']), async (req, res) => {
    const tandas = await leerTandas();
    res.json(tandas);
});

// Solo el admin puede cambiar los precios de cada tanda o cuál está activa
app.patch('/api/admin/tandas', verificarSesion(['admin']), async (req, res) => {
    const { primera, segunda, tercera, tandaActiva } = req.body;
    const tandas = await leerTandas();

    if (primera !== undefined) {
        const p = parseFloat(primera);
        if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de primera tanda inválido' });
        tandas.primera = p;
    }
    if (segunda !== undefined) {
        const p = parseFloat(segunda);
        if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de segunda tanda inválido' });
        tandas.segunda = p;
    }
    if (tercera !== undefined) {
        const p = parseFloat(tercera);
        if (isNaN(p) || p < 0) return res.status(400).json({ error: 'Precio de tercera tanda inválido' });
        tandas.tercera = p;
    }
    if (tandaActiva !== undefined) {
        if (!['primera', 'segunda', 'tercera'].includes(tandaActiva)) {
            return res.status(400).json({ error: 'tandaActiva debe ser: primera, segunda o tercera' });
        }
        tandas.tandaActiva = tandaActiva;
    }

    await guardarArchivo(tandasPath, tandas);
    res.json({ mensaje: 'Tandas actualizadas correctamente', tandas });
});

// ==========================================
// RUTAS PROTEGIDAS CON ACCESO SEGÚN ROL
// ==========================================

// Helper compartido: arma el ticket, genera el QR, manda el mail y lo persiste.
// Lo usan tanto /api/registrar (RRPP, siempre general) como /api/admin/registrar-especial (admin, cumpleaños/2x1).
async function crearTicketYEnviarMail({ nombre, email, tipoTicket, tanda, cantidadPersonas, precio, vendedorId }, res) {
    const compradores = await leerArchivo(compradoresPath);

    const nuevoTicket = {
        id: uuidv4().split('-')[0],
        nombre,
        email,
        tipoTicket,
        tanda,
        cantidadPersonas,
        precio,
        asistio: false,
        vendedorId,
        fechaRegistro: new Date().toISOString()
    };

    const urlValidacion = `http://localhost:5173/validar/${nuevoTicket.id}`;
    const qrImagenUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(urlValidacion)}`;

    let etiquetaTipo = `Entrada General · Tanda ${tanda}`;
    if (tipoTicket === 'cumpleanos') {
        etiquetaTipo = `🎂 Lista de Cumpleaños · ${cantidadPersonas} persona${cantidadPersonas > 1 ? 's' : ''} en total`;
    } else if (tipoTicket === '2x1') {
        etiquetaTipo = `🎉 2x1 · Tanda ${tanda} · ingresan 2 personas`;
    }

    const mailOptions = {
        from: '"Control de Accesos Baco" <baco.producciones26@gmail.com>',
        to: email,
        subject: `¡Tu entrada para el Evento está lista! 🎟️ - ${nombre}`,
        html: `
            <div style="font-family: sans-serif; background-color: #111827; color: #ffffff; padding: 30px; text-align: center; max-width: 500px; margin: 0 auto; border-radius: 12px; border: 1px solid #1f2937;">
                <h2 style="color: #818cf8; font-size: 24px; margin-bottom: 10px;">¡Hola, ${nombre}!</h2>
                <p style="color: #9ca3af; font-size: 16px;">Tu entrada para el evento se procesó con éxito.</p>
                <p style="color: #a5b4fc; font-size: 14px; font-weight: bold; margin-bottom: 5px;">${etiquetaTipo}</p>
                <p style="color: #9ca3af; font-size: 14px; margin-bottom: 25px;">Presentá este código QR en tu celular al ingresar a la puerta.</p>
                
                <div style="background-color: #ffffff; padding: 15px; display: inline-block; border-radius: 8px; margin-bottom: 25px;">
                    <img src="${qrImagenUrl}" alt="Código QR de Acceso" style="display: block; width: 250px; height: 250px;" />
                </div>
                
                <p style="font-size: 12px; color: #4b5563; margin-top: 15px; font-family: monospace;">ID único de ticket: ${nuevoTicket.id}</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        compradores.push(nuevoTicket);
        await guardarArchivo(compradoresPath, compradores);
        res.status(201).json({ mensaje: `¡Registro exitoso! La entrada con el QR fue enviada a: ${email}`, ticket: nuevoTicket });
    } catch (error) {
        console.error("Error en Nodemailer:", error);
        res.status(500).json({ error: 'No se pudo enviar el correo electrónico con el QR.' });
    }
}

// RUTA DEL RRPP: siempre genera una entrada GENERAL, a la tanda vigente.
// El RRPP no elige tanda, ni carga cumpleaños ni 2x1 — eso es exclusivo del admin.
app.post('/api/registrar', verificarSesion(['rrpp']), async (req, res) => {
    const { nombre, email } = req.body;

    if (!nombre || !email) {
        return res.status(400).json({ error: 'Faltan datos requeridos (nombre y email)' });
    }

    const tandas = await leerTandas();
    const tandaActiva = tandas.tandaActiva;
    const precio = tandas[tandaActiva];

    await crearTicketYEnviarMail({
        nombre,
        email,
        tipoTicket: 'general',
        tanda: tandaActiva,
        cantidadPersonas: 1,
        precio,
        vendedorId: req.usuarioSesion.usuarioId
    }, res);
});

// RUTA EXCLUSIVA DEL ADMIN: cumpleaños (gratis, con acompañantes) y 2x1 (una tanda, ingresan 2)
app.post('/api/admin/registrar-especial', verificarSesion(['admin']), async (req, res) => {
    const { nombre, email, tipoTicket, tanda, cantidadPersonas } = req.body;

    if (!nombre || !email) {
        return res.status(400).json({ error: 'Faltan datos requeridos (nombre y email)' });
    }

    if (!['cumpleanos', '2x1'].includes(tipoTicket)) {
        return res.status(400).json({ error: 'tipoTicket inválido. Debe ser: cumpleanos o 2x1' });
    }

    let precioFinal = 0;
    let tandaFinal = null;
    let personas = 1;

    if (tipoTicket === 'cumpleanos') {
        const acompanantes = parseInt(cantidadPersonas);
        if (!Number.isInteger(acompanantes) || acompanantes < 0) {
            return res.status(400).json({ error: 'Para la lista de cumpleaños hay que indicar cantidadPersonas (acompañantes) como un número válido (0 o más)' });
        }
        precioFinal = 0;
        personas = acompanantes + 1;

    } else if (tipoTicket === '2x1') {
        const tandas = await leerTandas();
        const tandaElegida = tanda || tandas.tandaActiva;

        if (!['primera', 'segunda', 'tercera'].includes(tandaElegida)) {
            return res.status(400).json({ error: 'tanda inválida. Debe ser: primera, segunda o tercera' });
        }

        precioFinal = tandas[tandaElegida];
        tandaFinal = tandaElegida;
        personas = 2;
    }

    await crearTicketYEnviarMail({
        nombre,
        email,
        tipoTicket,
        tanda: tandaFinal,
        cantidadPersonas: personas,
        precio: precioFinal,
        vendedorId: 'ADMIN-ESPECIAL'
    }, res);
});

app.get('/api/bebidas/catalogo', verificarSesion(['barra']), (req, res) => {
    res.json(CATALOGO_BEBIDAS);
});

// CORREGIDO: ahora acepta "sabor" para la Jarra Gaseosa (Coca-Cola o Sprite)
app.post('/api/bebidas/anotar', verificarSesion(['barra']), async (req, res) => {
    const { producto, cantidad, sabor } = req.body;

    if (!producto || !cantidad) {
        return res.status(400).json({ error: 'Faltan datos de la venta' });
    }

    const precioUnitario = CATALOGO_BEBIDAS[producto];
    if (precioUnitario === undefined) {
        return res.status(400).json({ error: 'Producto no reconocido' });
    }

    const cantidadNum = parseInt(cantidad);
    if (!Number.isInteger(cantidadNum) || cantidadNum <= 0) {
        return res.status(400).json({ error: 'Cantidad inválida' });
    }

    // La Jarra Gaseosa requiere indicar el sabor porque de eso depende qué insumo se descuenta
    if (producto === 'Jarra Gaseosa' && sabor !== 'Coca-Cola' && sabor !== 'Sprite') {
        return res.status(400).json({ error: 'Para la Jarra Gaseosa hay que indicar el sabor: "Coca-Cola" o "Sprite".' });
    }

    const ventasBebidas = await leerArchivo(bebidaPath);

    const nuevaVenta = {
        id: uuidv4().split('-')[0],
        producto,
        cantidad: cantidadNum,
        ...(producto === 'Jarra Gaseosa' ? { sabor } : {}),
        precioUnitario,
        precioTotal: precioUnitario * cantidadNum,
        encargadoId: req.usuarioSesion.usuarioId, 
        fechaVenta: new Date().toISOString()
    };

    ventasBebidas.push(nuevaVenta);
    await guardarArchivo(bebidaPath, ventasBebidas);

    res.status(201).json({ mensaje: 'Bebida anotada correctamente', venta: nuevaVenta });
});

// ACTUALIZADO: ahora informa cuántas personas ingresan y el tipo de ticket (útil para
// tickets de cumpleaños o 2x1, donde con un solo QR entra más de una persona)
app.patch('/api/validar/:id', verificarSesion(['rrpp', 'control']), async (req, res) => {
    const { id } = req.params;
    const compradores = await leerArchivo(compradoresPath);
    
    const comprador = compradores.find(c => c.id === id);

    if (!comprador) {
        return res.status(404).json({ estado: 'INVALIDO', mensaje: 'El ticket no pertenece a la lista o es inválido.' });
    }

    if (comprador.asistio) {
        return res.status(200).json({ 
            estado: 'REPETIDO', 
            mensaje: `¡ALERTA! Este ticket ya ingresó. Pertenece a ${comprador.nombre}`,
            cantidadPersonas: comprador.cantidadPersonas || 1,
            tipoTicket: comprador.tipoTicket || 'general'
        });
    }

    comprador.asistio = true;
    await guardarArchivo(compradoresPath, compradores);

    let mensajeExtra = '';
    if (comprador.tipoTicket === 'cumpleanos') {
        mensajeExtra = ` — 🎂 Cumpleaños: ingresan ${comprador.cantidadPersonas} persona(s) en total.`;
    } else if (comprador.tipoTicket === '2x1') {
        mensajeExtra = ' — 🎉 2x1: ingresan 2 personas con este QR.';
    }

    res.status(200).json({ 
        estado: 'VALIDO', 
        mensaje: `¡Acceso concedido! Bienvenido/a, ${comprador.nombre}.${mensajeExtra}`,
        cantidadPersonas: comprador.cantidadPersonas || 1,
        tipoTicket: comprador.tipoTicket || 'general',
        tanda: comprador.tanda || null
    });
});

app.patch('/api/bebidas/canjear-vale/:codigo', verificarSesion(['barra']), async (req, res) => {
    const { codigo } = req.params;
    const vales = await leerArchivo(valesOtorgadosPath);
    
    const vale = vales.find(v => v.codigo.toLowerCase() === codigo.toLowerCase());

    if (!vale) {
        return res.status(404).json({ error: 'El código de vale es inválido o no existe.' });
    }

    if (vale.estado === 'CANJEADO') {
        return res.status(400).json({ error: `¡ERROR! Este vale ya fue canjeado el ${new Date(vale.fechaCanje).toLocaleString('es-AR')}.` });
    }

    vale.estado = 'CANJEADO';
    vale.fechaCanje = new Date().toISOString();
    vale.atendidoPor = req.usuarioSesion.usuarioId;

    await guardarArchivo(valesOtorgadosPath, vales);
    res.json({ mensaje: `¡Vale verificado con éxito! Otorga: ${vale.premio} a ${vale.rrppNombre}` });
});

// ==========================================
// RUTAS EXCLUSIVAS DEL PANEL DE ADMIN
// ==========================================

app.get('/api/admin/total-bebidas', verificarSesion(['admin']), async (req, res) => {
    const ventasBebidas = await leerArchivo(bebidaPath);
    const totalBebidas = ventasBebidas.reduce((acumulador, venta) => acumulador + (venta.cantidad || 0), 0);
    const montoTotal = ventasBebidas.reduce((acumulador, venta) => acumulador + (venta.precioTotal || 0), 0);
    
    res.json({ total: totalBebidas, montoTotal: montoTotal });
});

// NUEVO: dinero recaudado por entradas, desglosado por tipo de ticket y por tanda.
// Los tickets de cumpleaños siempre suman $0, tal como se pidió.
app.get('/api/admin/total-entradas', verificarSesion(['admin']), async (req, res) => {
    const compradores = await leerArchivo(compradoresPath);

    const resumenPorTipo = {
        general: { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 },
        '2x1': { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 },
        cumpleanos: { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 },
        regalo: { cantidadTickets: 0, personasTotales: 0, personasIngresadas: 0, monto: 0 } // entradas otorgadas por el admin
    };

    const resumenPorTanda = {
        primera: { cantidadTickets: 0, monto: 0 },
        segunda: { cantidadTickets: 0, monto: 0 },
        tercera: { cantidadTickets: 0, monto: 0 }
    };

    let montoTotal = 0;
    let personasVendidasTotal = 0;
    let personasIngresadasTotal = 0;

    compradores.forEach(c => {
        const tipo = c.tipoTicket || 'general';
        const personas = c.cantidadPersonas || 1;
        const precio = c.precio || 0;

        if (resumenPorTipo[tipo]) {
            resumenPorTipo[tipo].cantidadTickets += 1;
            resumenPorTipo[tipo].personasTotales += personas;
            resumenPorTipo[tipo].monto += precio;
            if (c.asistio) {
                resumenPorTipo[tipo].personasIngresadas += personas;
            }
        }

        if (c.tanda && resumenPorTanda[c.tanda]) {
            resumenPorTanda[c.tanda].cantidadTickets += 1;
            resumenPorTanda[c.tanda].monto += precio;
        }

        montoTotal += precio;
        personasVendidasTotal += personas;
        if (c.asistio) {
            personasIngresadasTotal += personas;
        }
    });

    res.json({
        montoTotal,
        personasVendidasTotal,
        personasIngresadasTotal,
        porTipo: resumenPorTipo,
        porTanda: resumenPorTanda
    });
});

// ACTUALIZADO: ahora también muestra el dinero y la cantidad de personas que generó cada RRPP
app.get('/api/admin/listado-rrpp', verificarSesion(['admin']), async (req, res) => {
    const usuarios = await leerArchivo(rrppPath);
    const compradores = await leerArchivo(compradoresPath);
    
    const listaRrpp = usuarios
        .filter(u => u.rol === 'rrpp')
        .map(u => {
            const entradasDelVendedor = compradores.filter(c => c.vendedorId === u.id);
            const entradasVendidas = entradasDelVendedor.length;
            const personasVendidas = entradasDelVendedor.reduce((acc, c) => acc + (c.cantidadPersonas || 1), 0);
            const montoGenerado = entradasDelVendedor.reduce((acc, c) => acc + (c.precio || 0), 0);

            return {
                _id: u.id,
                nombre: u.nombre,
                usuario: u.usuario,
                historias: u.historias || 0,
                entradasVendidas,
                personasVendidas,
                montoGenerado
            };
        });
    res.json(listaRrpp);
});

app.patch('/api/admin/rrpp/:id/historias', verificarSesion(['admin']), async (req, res) => {
    const { id } = req.params;
    const { cambio } = req.body;

    if (cambio !== 1 && cambio !== -1) {
        return res.status(400).json({ error: 'Cambio inválido.' });
    }

    const usuarios = await leerArchivo(rrppPath);
    const usuarioIndex = usuarios.findIndex(u => u.id === id && u.rol === 'rrpp');

    if (usuarioIndex === -1) {
        return res.status(404).json({ error: 'RRPP no encontrado' });
    }

    if (usuarios[usuarioIndex].historias === undefined) {
        usuarios[usuarioIndex].historias = 0;
    }

    usuarios[usuarioIndex].historias = Math.max(0, usuarios[usuarioIndex].historias + cambio);
    await guardarArchivo(rrppPath, usuarios);
    res.json({ mensaje: 'Historias actualizadas', historias: usuarios[usuarioIndex].historias });
});

app.get('/api/admin/vales-historial', verificarSesion(['admin']), async (req, res) => {
    const historial = await leerArchivo(valesOtorgadosPath);
    res.json(historial);
});

// NUEVO: Stock por INSUMO físico (botellas/unidades), no por producto vendido.
// Calcula el consumo real aplicando la receta de cada venta registrada en bebida.json
app.get('/api/admin/stock-insumos', verificarSesion(['admin']), async (req, res) => {
    const stockGuardado = await leerArchivo(stockInsumosPath);
    const ventasBebidas = await leerArchivo(bebidaPath);

    // Acumulamos cuánto se consumió de cada insumo, aplicando la receta de cada venta
    const consumoPorInsumo = {};
    ventasBebidas.forEach(venta => {
        const consumos = calcularConsumoInsumos(venta);
        consumos.forEach(({ insumo, cantidad }) => {
            consumoPorInsumo[insumo] = (consumoPorInsumo[insumo] || 0) + cantidad;
        });
    });

    const listaStock = Object.keys(INSUMOS).map(insumo => {
        const stockItem = stockGuardado.find(s => s.insumo === insumo);
        const stockActual = stockItem ? stockItem.cantidad : 0;
        const consumido = consumoPorInsumo[insumo] || 0;
        const restante = Math.max(0, stockActual - consumido);

        return {
            insumo,
            tipo: INSUMOS[insumo].tipo, // 'botella' o 'unidad'
            stockActual: Math.round(stockActual * 100) / 100,
            consumido: Math.round(consumido * 100) / 100,
            restante: Math.round(restante * 100) / 100
        };
    });

    res.json(listaStock);
});

// NUEVO: el admin carga/actualiza la cantidad de stock de un insumo puntual
app.patch('/api/admin/stock-insumos/:insumo', verificarSesion(['admin']), async (req, res) => {
    const { insumo } = req.params;
    const { cantidad } = req.body;

    if (!INSUMOS[insumo]) {
        return res.status(400).json({ error: 'Insumo no reconocido.' });
    }

    const cantidadNum = parseFloat(cantidad);
    if (isNaN(cantidadNum) || cantidadNum < 0) {
        return res.status(400).json({ error: 'La cantidad debe ser un número mayor o igual a 0.' });
    }

    const stockGuardado = await leerArchivo(stockInsumosPath);
    const index = stockGuardado.findIndex(s => s.insumo === insumo);

    if (index === -1) {
        stockGuardado.push({ insumo, cantidad: cantidadNum });
    } else {
        stockGuardado[index].cantidad = cantidadNum;
    }

    await guardarArchivo(stockInsumosPath, stockGuardado);
    res.json({ mensaje: `Stock de ${insumo} actualizado a ${cantidadNum} ${INSUMOS[insumo].tipo}(s).`, stockActual: cantidadNum });
});

// CORREGIDO: Lógica de contingencia. Si falla Nodemailer, el vale impacta igual en el JSON y retorna éxito local con el código
app.post('/api/admin/otorgar-vale', verificarSesion(['admin']), async (req, res) => {
    const { rrppId, tipoPremio, premioDetalle } = req.body; 

    if (!rrppId || !tipoPremio || !premioDetalle) {
        return res.status(400).json({ error: 'Faltan parámetros: rrppId, tipoPremio o premioDetalle.' });
    }

    const usuarios = await leerArchivo(rrppPath);
    const rrpp = usuarios.find(u => u.id === rrppId && u.rol === 'rrpp');

    if (!rrpp) {
        return res.status(404).json({ error: 'No se encontró al RRPP especificado.' });
    }

    // Tomamos el mail real cargado obligatoriamente en la base de datos
    const correoDestinatario = rrpp.email;

    if (tipoPremio === 'entrada') {
        const compradores = await leerArchivo(compradoresPath);
        const ticketId = uuidv4().split('-')[0];

        const nuevoTicket = {
            id: ticketId,
            nombre: `${rrpp.nombre} (Premio Staff)`,
            email: correoDestinatario,
            tipoTicket: 'regalo', // entrada otorgada por el admin, no suma dinero
            tanda: null,
            cantidadPersonas: 1,
            precio: 0,
            asistio: false,
            vendedorId: `ADMIN-PREMIO`, 
            fechaRegistro: new Date().toISOString()
        };

        const urlValidacion = `http://localhost:5173/validar/${ticketId}`;
        const qrImagenUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(urlValidacion)}`;

        const mailOptions = {
            from: '"Administración Baco" <baco.producciones26@gmail.com>',
            to: correoDestinatario,
            subject: `🎁 ¡Acá tenés tu Entrada de Regalo! - ${rrpp.nombre}`,
            html: `
                <div style="font-family: sans-serif; background-color: #111827; color: #ffffff; padding: 30px; text-align: center; max-width: 500px; margin: 0 auto; border-radius: 12px; border: 1px solid #1f2937;">
                    <h2 style="color: #a855f7; font-size: 24px; margin-bottom: 10px;">¡Premio para ${rrpp.nombre}! 🎟️</h2>
                    <p style="color: #9ca3af; font-size: 15px;">Te otorgamos una entrada free en reconocimiento por tu laburo: <strong>${premioDetalle}</strong></p>
                    <p style="color: #9ca3af; font-size: 13px; margin-bottom: 25px;">Presentá este código QR directamente al personal de Control en la puerta.</p>
                    <div style="background-color: #ffffff; padding: 15px; display: inline-block; border-radius: 8px; margin-bottom: 25px;">
                        <img src="${qrImagenUrl}" alt="QR Entrada Regalada" style="display: block; width: 250px; height: 250px;" />
                    </div>
                    <p style="font-size: 11px; color: #4b5563; font-family: monospace;">ID de Entrada: ${ticketId}</p>
                </div>
            `
        };

        // Contingencia: Intentamos mandar, si falla guardamos igual en archivo
        compradores.push(nuevoTicket);
        await guardarArchivo(compradoresPath, compradores);

        try {
            await transporter.sendMail(mailOptions);
            return res.status(201).json({ mensaje: `¡Premio emitido! Entrada free enviada con éxito a ${correoDestinatario}.` });
        } catch (error) {
            console.error("⚠️ Error Nodemailer (Entrada):", error.message);
            return res.status(201).json({ mensaje: `⚠️ Registrado en base de datos, pero falló el envío del mail. ID del ticket: ${ticketId}` });
        }

    } else if (tipoPremio === 'bebida') {
        const valesEmitidos = await leerArchivo(valesOtorgadosPath);
        const codigoVale = `BACO-${uuidv4().split('-')[0].toUpperCase()}`;

        const nuevoVale = {
            id: uuidv4().split('-')[0],
            codigo: codigoVale,
            rrppId: rrpp.id,
            rrppNombre: rrpp.nombre,
            premio: premioDetalle,
            fechaEntrega: new Date().toISOString(),
            estado: 'PENDIENTE'
        };

        const mailOptions = {
            from: '"Premios Barra Baco" <baco.producciones26@gmail.com>',
            to: correoDestinatario,
            subject: `🎁 ¡Tenés un Vale de Barra Libre! - ${rrpp.nombre}`,
            html: `
                <div style="font-family: sans-serif; background-color: #0f172a; color: #ffffff; padding: 30px; text-align: center; max-width: 500px; margin: 0 auto; border-radius: 12px; border: 1px solid #334155;">
                    <h2 style="color: #38bdf8; font-size: 24px; margin-bottom: 5px;">¡Vale de Consumición! 🎉</h2>
                    <p style="color: #94a3b8; font-size: 15px; margin-bottom: 20px;">Ganaste un beneficio para retirar en barra: </p>
                    <div style="background-color: #1e293b; padding: 20px; border-radius: 8px; border: 1px dashed #38bdf8; margin-bottom: 20px;">
                        <strong style="font-size: 20px; color: #f43f5e; display: block; margin-bottom: 15px;">${premioDetalle}</strong>
                        <span style="font-family: monospace; font-size: 22px; font-weight: bold; color: #38bdf8; background-color: #0f172a; padding: 6px 15px; border-radius: 4px; display: inline-block; letter-spacing: 2px;">
                            ${codigoVale}
                        </span>
                    </div>
                    <p style="font-size: 13px; color: #64748b;">Mostrá este código único en la Barra. Solo sirve para un (1) uso único.</p>
                </div>
            `
        };

        valesEmitidos.push(nuevoVale);
        await guardarArchivo(valesOtorgadosPath, valesEmitidos);

        try {
            await transporter.sendMail(mailOptions);
            return res.status(201).json({ mensaje: `¡Premio emitido! Vale [ ${codigoVale} ] enviado a ${correoDestinatario}.` });
        } catch (error) {
            console.error("⚠️ Error Nodemailer (Bebida):", error.message);
            return res.status(201).json({ mensaje: `⚠️ Registrado en sistema (Fallo de Red/Mail). Copiá este código para el RRPP: [ ${codigoVale} ]` });
        }
    } else {
        return res.status(400).json({ error: 'Tipo de premio no soportado.' });
    }
});

// ==========================================
// GASTOS DEL EVENTO (nombre, descripción, precio) — exclusivo de admin
// ==========================================

// Lista todos los gastos cargados + el total acumulado
app.get('/api/admin/gastos', verificarSesion(['admin']), async (req, res) => {
    const gastos = await leerArchivo(gastosPath);
    const totalGastos = gastos.reduce((acumulador, gasto) => acumulador + (gasto.precio || 0), 0);

    res.json({ gastos, totalGastos });
});

// Carga un nuevo gasto
app.post('/api/admin/gastos', verificarSesion(['admin']), async (req, res) => {
    const { nombre, descripcion, precio } = req.body;

    if (!nombre || !descripcion) {
        return res.status(400).json({ error: 'Faltan datos: nombre y descripción son obligatorios.' });
    }

    const precioNum = parseFloat(precio);
    if (isNaN(precioNum) || precioNum < 0) {
        return res.status(400).json({ error: 'El precio debe ser un número mayor o igual a 0.' });
    }

    const gastos = await leerArchivo(gastosPath);

    const nuevoGasto = {
        id: uuidv4().split('-')[0],
        nombre,
        descripcion,
        precio: precioNum,
        registradoPor: req.usuarioSesion.usuarioId,
        fechaRegistro: new Date().toISOString()
    };

    gastos.push(nuevoGasto);
    await guardarArchivo(gastosPath, gastos);

    const totalGastos = gastos.reduce((acumulador, gasto) => acumulador + (gasto.precio || 0), 0);

    res.status(201).json({ mensaje: 'Gasto registrado correctamente', gasto: nuevoGasto, totalGastos });
});

// Elimina un gasto cargado por error
app.delete('/api/admin/gastos/:id', verificarSesion(['admin']), async (req, res) => {
    const { id } = req.params;
    const gastos = await leerArchivo(gastosPath);

    const index = gastos.findIndex(g => g.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Gasto no encontrado.' });
    }

    gastos.splice(index, 1);
    await guardarArchivo(gastosPath, gastos);

    const totalGastos = gastos.reduce((acumulador, gasto) => acumulador + (gasto.precio || 0), 0);

    res.json({ mensaje: 'Gasto eliminado correctamente', totalGastos });
});

// ==========================================
// ARRANQUE DEL SERVIDOR
// ==========================================
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor de BacoTickets corriendo en: http://localhost:${PORT}`);
});